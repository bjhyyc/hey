import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(require.resolve("../../package.json")));

// Migration 023 broke an assumption that had held since the first pack shipped:
// one production run, one petpack_build. A delivered-pack redo now leaves the
// superseded build in place - it is the pack the customer is still downloading,
// and its manifest, checksum and QA reports are that pack's only provenance -
// while the replacement is built beside it.
//
// Every query that asks "the build for this run" therefore has to say which one
// it means. Three did not, and each failed the same way, one step further along:
// the build commit inferred ON CONFLICT (run_id) and hit the superseded row;
// then the validation claim's oneRow() saw two builds; then delivery would
// have. Nothing in a scripted-database test catches this, because the second
// row only exists in a database that has been through a redo.
//
// This test holds the invariant at the source: since 023 the only run-scoped
// uniqueness is the partial index over live builds, so a run-keyed build lookup
// must repeat that predicate.

const SOURCES = [
  "platform/src/persistence/postgres-petpack-worker-repository.js",
  "platform/src/persistence/postgres-transactional-workflow-store.js",
  "platform/src/persistence/postgres-petpack-studio-repository.js"
];

/** Every backtick-delimited SQL literal that mentions petpack_build. */
function buildStatements(file) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const statements = [];
  const literal = /`([^`]*)`/g;
  let match;
  while ((match = literal.exec(source)) !== null) {
    const sql = match[1];
    if (!/petpack_build\b/.test(sql)) continue;
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(sql)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    statements.push({ file, line, sql });
  }
  return statements;
}

// Keyed on the run: it asks for a run's build without naming which build.
function isRunKeyed(sql) {
  const byRun = /build\.run_id\s*=\s*(\$\d+|run\.id)/i.test(sql)
    || /petpack_build\s+SET[\s\S]*WHERE[^;]*run_id\s*=\s*\$/i.test(sql)
    || /FROM\s+petpack_build\s+WHERE\s+run_id\s*=\s*\$/i.test(sql)
    || /INSERT\s+INTO\s+petpack_build\b[\s\S]*ON\s+CONFLICT\s*\(\s*run_id\s*\)/i.test(sql);
  if (!byRun) return false;
  // Naming a specific build makes the run condition a consistency check, not
  // the way the row is chosen.
  const byBuildId = /build\.id\s*=\s*(\$\d+|delivery\.petpack_build_id)/i.test(sql)
    || /petpack_build\s+SET[\s\S]*WHERE\s+id\s*=\s*\$/i.test(sql);
  return !byBuildId;
}

// Says which of a run's builds it means: the live one, by repeating the
// predicate of the partial unique index, or by naming live statuses.
function disambiguatesSuperseded(sql) {
  return /status\s*<>\s*'superseded'/i.test(sql)
    || /status\s*=\s*'superseded'/i.test(sql)
    || /status\s+IN\s*\('built',\s*'validating'\)/i.test(sql)
    || /status\s*=\s*'validated'/i.test(sql);
}

describe("petpack_build lookups survive a delivered-pack redo", () => {
  const statements = SOURCES.flatMap(buildStatements);

  it("finds the statements to check", () => {
    expect(statements.length).toBeGreaterThan(8);
    expect(statements.some((statement) => isRunKeyed(statement.sql))).toBe(true);
  });

  it("every run-keyed build lookup says which build it means", () => {
    const ambiguous = statements
      .filter((statement) => isRunKeyed(statement.sql) && !disambiguatesSuperseded(statement.sql))
      .map((statement) => `${statement.file}:${statement.line}`);
    expect(ambiguous).toEqual([]);
  });

  it("rejects a lookup that forgets the predicate", () => {
    // A guard on the guard, in the exact shape that failed in production.
    const forgetful = "SELECT build.id FROM petpack_build build WHERE build.run_id = $1";
    expect(isRunKeyed(forgetful)).toBe(true);
    expect(disambiguatesSuperseded(forgetful)).toBe(false);
    const fixed = `${forgetful} AND build.status <> 'superseded'`;
    expect(disambiguatesSuperseded(fixed)).toBe(true);
    // Naming the build is the other way to be unambiguous.
    expect(isRunKeyed("UPDATE petpack_build SET status = 'validated' WHERE id = $1")).toBe(false);
  });
});
