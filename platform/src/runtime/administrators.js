/**
 * Appoints and audits the single support-console administrator.
 *
 * Nothing in the application can grant the admin role - phone signup always
 * writes `role='user'`, and no endpoint changes a role - so the only way an
 * administrator can exist is this script, run by whoever holds the database
 * credentials. That is deliberate: it keeps the privilege off the network
 * entirely. What was missing was a safe way to use it, so appointments were
 * hand-written UPDATEs with nothing to stop a typo appointing two people and
 * nothing to answer "who is an administrator right now".
 *
 * Phone numbers are never accepted or printed here. Migration 010 keeps them
 * out of PostgreSQL entirely - not even hashed - so an account is identified
 * by its own ID or by the opaque CloudBase subject on its auth identity. The
 * intended flow is: sign in once on the real site with the phone that should
 * own the console, then appoint the account that login created.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") {
    throw new Error("A PostgreSQL transaction runner is required");
  }
  return database;
}

function requireUserId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error("An account ID must be a UUID");
  }
  return value.trim();
}

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

/**
 * Who holds the role now, and which accounts signed in most recently - the
 * second list is how an operator finds the account their own login just
 * created without any personal data being stored or shown.
 */
async function listAdministrators({ database, recentLogins = 5 } = {}) {
  const db = requireDatabase(database);
  return db.transaction(async (tx) => {
    const administrators = rows(await tx.query(
      `SELECT app_user.id, app_user.status, app_user.created_at,
              identity.provider, identity.provider_subject, identity.last_login_at
         FROM app_user
         LEFT JOIN auth_identity identity ON identity.user_id = app_user.id
        WHERE app_user.role = 'admin'
        ORDER BY app_user.created_at`
    ));
    const candidates = rows(await tx.query(
      `SELECT app_user.id, app_user.role, app_user.status, identity.last_login_at
         FROM auth_identity identity
         JOIN app_user app_user ON app_user.id = identity.user_id
        ORDER BY identity.last_login_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(50, Number(recentLogins) || 5))]
    ));
    return {
      administrators: administrators.map((row) => ({
        id: row.id,
        status: row.status,
        provider: row.provider || null,
        // The opaque CloudBase subject, shown truncated: enough to tell two
        // identities apart, never enough to be an identifier on its own.
        providerSubject: row.provider_subject ? `${String(row.provider_subject).slice(0, 8)}…` : null,
        lastLoginAt: row.last_login_at || null,
        createdAt: row.created_at || null
      })),
      recentLogins: candidates.map((row) => ({
        id: row.id,
        role: row.role,
        status: row.status,
        lastLoginAt: row.last_login_at || null
      }))
    };
  });
}

/**
 * Makes exactly one account the administrator. Any other administrator is
 * demoted in the same transaction, so "there is one console owner" is a
 * property the database holds rather than a habit the operator has to keep.
 * Demoting others requires `replaceExisting`, so a second appointment cannot
 * happen by accident.
 */
async function appointAdministrator({ database, userId, replaceExisting = false, idFactory = require("node:crypto").randomUUID } = {}) {
  const db = requireDatabase(database);
  const safeUserId = requireUserId(userId);
  return db.transaction(async (tx) => {
    const target = rows(await tx.query(
      "SELECT id, role, status FROM app_user WHERE id = $1 FOR UPDATE",
      [safeUserId]
    ));
    if (target.length !== 1) {
      throw new Error("That account does not exist; sign in once on the site first, then appoint the account the login created");
    }
    if (target[0].status !== "active") {
      throw new Error("A disabled account cannot be appointed");
    }
    const others = rows(await tx.query(
      "SELECT id FROM app_user WHERE role = 'admin' AND id <> $1 FOR UPDATE",
      [safeUserId]
    ));
    if (others.length > 0 && !replaceExisting) {
      throw new Error(
        `${others.length} other administrator(s) already exist. Re-run with --replace to make this account the only one.`
      );
    }
    for (const other of others) {
      await tx.query("UPDATE app_user SET role = 'user', updated_at = now() WHERE id = $1", [other.id]);
      await tx.query(
        `INSERT INTO audit_event (id, actor_id, event_type, metadata)
         VALUES ($1, $2, 'admin_role_revoked', $3::jsonb)`,
        [idFactory(), safeUserId, JSON.stringify({ targetUserId: other.id, reason: "replaced_by_appointment" })]
      );
    }
    const promoted = rows(await tx.query(
      `UPDATE app_user SET role = 'admin', updated_at = now()
        WHERE id = $1 AND status = 'active'
      RETURNING id, role`,
      [safeUserId]
    ));
    if (promoted.length !== 1) throw new Error("The account could not be appointed");
    await tx.query(
      `INSERT INTO audit_event (id, actor_id, event_type, metadata)
       VALUES ($1, $2, 'admin_role_granted', $3::jsonb)`,
      [idFactory(), safeUserId, JSON.stringify({ targetUserId: safeUserId, replacedAdministrators: others.length })]
    );
    return { id: promoted[0].id, role: promoted[0].role, demoted: others.length };
  });
}

async function revokeAdministrator({ database, userId, idFactory = require("node:crypto").randomUUID } = {}) {
  const db = requireDatabase(database);
  const safeUserId = requireUserId(userId);
  return db.transaction(async (tx) => {
    const demoted = rows(await tx.query(
      `UPDATE app_user SET role = 'user', updated_at = now()
        WHERE id = $1 AND role = 'admin'
      RETURNING id`,
      [safeUserId]
    ));
    if (demoted.length !== 1) throw new Error("That account is not an administrator");
    await tx.query(
      `INSERT INTO audit_event (id, actor_id, event_type, metadata)
       VALUES ($1, $2, 'admin_role_revoked', $3::jsonb)`,
      [idFactory(), safeUserId, JSON.stringify({ targetUserId: safeUserId, reason: "manual_revocation" })]
    );
    return { id: safeUserId, role: "user" };
  });
}

function usage() {
  return [
    "Usage:",
    "  node platform/src/runtime/administrators.js --list",
    "  node platform/src/runtime/administrators.js --appoint <accountId> [--replace]",
    "  node platform/src/runtime/administrators.js --revoke <accountId>",
    "",
    "Sign in on the site with the phone that should own the console, then run",
    "--list and appoint the account whose last login you just made. Phone",
    "numbers are never stored, so the account ID is the only handle."
  ].join("\n");
}

async function main({ argv = process.argv.slice(2), environment = process.env, logger = console } = {}) {
  const { createPostgresDatabase } = require("../persistence/postgres-database");
  const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");
  // Run inside the deployed API container, where credentials arrive as mounted
  // files rather than as environment values - the same convention the runtime
  // itself uses. Without this the command can only run somewhere a plaintext
  // connection URL is lying around, which is the opposite of where it belongs.
  const database = createPostgresDatabase({
    environment: hydrateEnvironmentFromSecretFiles({ environment }),
    logger
  });
  try {
    if (argv.includes("--list")) {
      const result = await listAdministrators({ database });
      logger.info?.("Administrators:");
      if (result.administrators.length === 0) logger.info?.("  (none - the console cannot be used until one is appointed)");
      for (const admin of result.administrators) {
        logger.info?.(`  ${admin.id}  status=${admin.status}  identity=${admin.provider || "-"}:${admin.providerSubject || "-"}  lastLogin=${admin.lastLoginAt || "-"}`);
      }
      logger.info?.("Recent logins (appoint the one that is your own):");
      for (const candidate of result.recentLogins) {
        logger.info?.(`  ${candidate.id}  role=${candidate.role}  status=${candidate.status}  lastLogin=${candidate.lastLoginAt || "-"}`);
      }
      return result;
    }
    const appointIndex = argv.indexOf("--appoint");
    if (appointIndex >= 0) {
      const result = await appointAdministrator({
        database,
        userId: argv[appointIndex + 1],
        replaceExisting: argv.includes("--replace")
      });
      logger.info?.(`Appointed ${result.id} as the administrator (demoted ${result.demoted} other(s)).`);
      return result;
    }
    const revokeIndex = argv.indexOf("--revoke");
    if (revokeIndex >= 0) {
      const result = await revokeAdministrator({ database, userId: argv[revokeIndex + 1] });
      logger.info?.(`Revoked the administrator role from ${result.id}.`);
      return result;
    }
    logger.info?.(usage());
    return null;
  } finally {
    if (typeof database.close === "function") await database.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : "administrator command failed"}\n`);
    process.exit(1);
  });
}

module.exports = { appointAdministrator, listAdministrators, revokeAdministrator, main, usage };
