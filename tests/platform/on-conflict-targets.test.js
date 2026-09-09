import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(require.resolve("../../package.json")));
const SQL_DIR = path.join(ROOT, "platform", "sql");
const SOURCE_DIRS = [
  path.join(ROOT, "platform", "src", "persistence"),
  path.join(ROOT, "platform", "src", "development")
];

// PostgreSQL validates an ON CONFLICT specification when it PLANS the
// statement, not when a row actually collides: an inference target with no
// matching unique index fails every single insert. So a migration that drops
// or renames a constraint silently breaks every writer that inferred on it,
// and nothing in a scripted-database unit test can see it.
//
// That is not hypothetical. Migration 022 dropped photo_precheck's UNIQUE
// (fingerprint) so a fingerprint could hold many rows; the insert kept saying
// ON CONFLICT (fingerprint), and the photo pre-check - the gate in front of
// every order - failed 100% of the time for a week before a customer reported
// "当前状态暂不能执行此操作".
//
// This test reconciles the two sides from their own sources: the uniqueness
// the migrations actually declare, and the inference targets the code asks
// for. It reads the shipped SQL, so it stays true without a live database.

function migrationSql() {
  return fs.readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(SQL_DIR, name), "utf8") }));
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, " ");
}

function columnKey(columns) {
  // An inference target is a SET of columns; order does not matter to Postgres.
  return columns
    .map((column) => column.trim().replace(/"/g, "").toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function matchingParen(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * The uniqueness each table carries after every migration is applied in order:
 * a map of table -> Set of sorted column keys, honouring later drops.
 */
function buildUniqueness() {
  const unique = new Map();
  const byConstraintName = new Map();
  const add = (table, columns, constraintName, { primaryKey = false } = {}) => {
    const key = columnKey(columns);
    if (!key) return;
    if (!unique.has(table)) unique.set(table, new Set());
    unique.get(table).add(key);
    const names = new Set();
    if (constraintName) names.add(constraintName.toLowerCase());
    // Unnamed constraints still get a name from PostgreSQL, and later
    // migrations drop them by it - photo_precheck_fingerprint_key, the one
    // this whole test exists for, was never named in its CREATE TABLE.
    const plain = columns.map((column) => column.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);
    names.add(primaryKey ? `${table}_pkey` : `${table}_${plain.join("_")}_key`);
    for (const name of names) byConstraintName.set(`${table}.${name}`, key);
  };

  for (const { sql } of migrationSql()) {
    const text = stripComments(sql);

    // CREATE TABLE bodies: column-level UNIQUE/PRIMARY KEY and table-level
    // UNIQUE (...) / PRIMARY KEY (...).
    const createTable = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_.]+)\s*\(/gi;
    let match;
    while ((match = createTable.exec(text)) !== null) {
      const table = match[1].replace(/^public\./, "").toLowerCase();
      const open = text.indexOf("(", match.index + match[0].length - 1);
      const close = matchingParen(text, open);
      if (close < 0) continue;
      for (const rawPart of splitTopLevel(text.slice(open + 1, close))) {
        const part = rawPart.trim();
        const tableLevel = /^(?:CONSTRAINT\s+([a-z0-9_]+)\s+)?(UNIQUE|PRIMARY\s+KEY)\s*\(([^)]*)\)/i.exec(part);
        if (tableLevel) {
          add(table, tableLevel[3].split(","), tableLevel[1], { primaryKey: /PRIMARY/i.test(tableLevel[2]) });
          continue;
        }
        const columnLevel = /^([a-z0-9_]+)\s+[^(]*?\b(UNIQUE|PRIMARY\s+KEY)\b/i.exec(part);
        if (columnLevel) add(table, [columnLevel[1]], null, { primaryKey: /PRIMARY/i.test(columnLevel[2]) });
      }
    }

    // ALTER TABLE ... ADD CONSTRAINT ... UNIQUE / PRIMARY KEY (...)
    const addConstraint =
      /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z0-9_.]+)[\s\S]*?ADD\s+CONSTRAINT\s+([a-z0-9_]+)\s+(?:UNIQUE|PRIMARY\s+KEY)\s*\(([^)]*)\)/gi;
    while ((match = addConstraint.exec(text)) !== null) {
      add(match[1].replace(/^public\./, "").toLowerCase(), match[3].split(","), match[2], {
        primaryKey: /PRIMARY/i.test(match[0])
      });
    }

    // CREATE UNIQUE INDEX ... ON table (...) [WHERE ...]. A partial index can
    // only back an ON CONFLICT that repeats its predicate; none of ours do, so
    // partial indexes deliberately do not count as plain inference targets.
    const uniqueIndex =
      /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)\s+ON\s+([a-z0-9_.]+)\s*(?:USING\s+[a-z]+\s*)?\(([^)]*)\)([^;]*)/gi;
    while ((match = uniqueIndex.exec(text)) !== null) {
      if (/\bWHERE\b/i.test(match[4])) continue;
      add(match[2].replace(/^public\./, "").toLowerCase(), match[3].split(","), match[1]);
    }

    // Drops remove the target again.
    const dropConstraint =
      /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z0-9_.]+)[\s\S]*?DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([a-z0-9_]+)/gi;
    while ((match = dropConstraint.exec(text)) !== null) {
      const table = match[1].replace(/^public\./, "").toLowerCase();
      const key = byConstraintName.get(`${table}.${match[2].toLowerCase()}`);
      if (key && unique.has(table)) unique.get(table).delete(key);
    }
    const dropIndex = /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([a-z0-9_.]+)/gi;
    while ((match = dropIndex.exec(text)) !== null) {
      const indexName = match[1].replace(/^public\./, "").toLowerCase();
      for (const [name, key] of byConstraintName.entries()) {
        if (!name.endsWith(`.${indexName}`)) continue;
        const table = name.slice(0, name.length - indexName.length - 1);
        if (unique.has(table)) unique.get(table).delete(key);
      }
    }
  }
  return unique;
}

/** Every `INSERT INTO <table> ... ON CONFLICT (<columns>)` the code issues. */
function collectInferenceTargets() {
  const targets = [];
  for (const dir of SOURCE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".js"))) {
      const file = path.join(dir, name);
      const source = fs.readFileSync(file, "utf8");
      const inserts = /INSERT\s+INTO\s+([a-z0-9_]+)\b([\s\S]*?)(?=INSERT\s+INTO\s|\n\s*`|$)/gi;
      let match;
      while ((match = inserts.exec(source)) !== null) {
        const table = match[1].toLowerCase();
        const conflict = /ON\s+CONFLICT\s*\(([^)]*)\)/i.exec(match[2]);
        if (!conflict) continue;
        targets.push({
          file: path.relative(ROOT, file).replace(/\\/g, "/"),
          table,
          columns: conflict[1].split(",").map((column) => column.trim()),
          key: columnKey(conflict[1].split(","))
        });
      }
    }
  }
  return targets;
}

describe("ON CONFLICT inference targets match the shipped schema", () => {
  const uniqueness = buildUniqueness();
  const targets = collectInferenceTargets();

  it("finds the inference targets and the uniqueness to check them against", () => {
    expect(targets.length).toBeGreaterThan(20);
    expect(uniqueness.get("customer_order")).toBeDefined();
    // The migration that started this: photo_precheck keeps its primary key
    // but no longer offers (fingerprint) as an inference target.
    expect(uniqueness.get("photo_precheck")?.has("id")).toBe(true);
    expect(uniqueness.get("photo_precheck")?.has("fingerprint")).toBe(false);
  });

  it("every ON CONFLICT target is backed by a unique constraint or index", () => {
    const unbacked = targets.filter((target) => !uniqueness.get(target.table)?.has(target.key));
    const detail = unbacked
      .map((target) => `${target.file}: INSERT INTO ${target.table} ON CONFLICT (${target.columns.join(", ")})`)
      .join("\n");
    expect(detail).toBe("");
    expect(unbacked).toEqual([]);
  });

  it("refuses an inference target a migration has dropped", () => {
    // A guard on the guard: the reconciliation must actually reject the shape
    // that broke production, not pass everything by accident.
    const key = columnKey(["fingerprint"]);
    expect(uniqueness.get("photo_precheck")?.has(key)).toBe(false);
    expect(uniqueness.get("photo_precheck")?.has(columnKey(["id"]))).toBe(true);
  });
});
