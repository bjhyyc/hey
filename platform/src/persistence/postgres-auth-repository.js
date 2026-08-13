const crypto = require("node:crypto");

const PROVIDERS = new Set(["TENCENT_CLOUDBASE"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireDatabase(database) {
  if (!database || typeof database.transaction !== "function") throw new Error("A PostgreSQL transaction runner is required");
  return database;
}

function requireQuery(transaction) {
  if (!transaction || typeof transaction.query !== "function") throw new Error("A PostgreSQL transaction query interface is required");
  return transaction;
}

function rows(result) {
  return Array.isArray(result && result.rows) ? result.rows : [];
}

function oneRow(result, message) {
  const found = rows(result);
  if (found.length !== 1) throw new Error(message);
  return found[0];
}

function requireProvider(value) {
  const provider = requiredString(value, "Identity provider");
  if (!PROVIDERS.has(provider)) throw new Error("Identity provider is unsupported");
  return provider;
}

function requireHash(value) {
  const hash = requiredString(value, "Session token hash");
  if (!HASH_PATTERN.test(hash)) throw new Error("Session token hash is invalid");
  return hash;
}

function requireTimestamp(value, label) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${label} is invalid`);
  return timestamp.toISOString();
}

class PostgresAuthRepository {
  constructor({ database, auditIdFactory = crypto.randomUUID, logger = console } = {}) {
    this.database = requireDatabase(database);
    if (typeof auditIdFactory !== "function") throw new Error("An auth audit ID factory is required");
    this.auditIdFactory = auditIdFactory;
    this.logger = logger;
  }

  async _transaction(callback) {
    return this.database.transaction(async (transaction) => callback(requireQuery(transaction)));
  }

  async createSessionForExternalIdentity(input = {}) {
    const provider = requireProvider(input.provider);
    const providerSubject = requiredString(input.providerSubject, "Provider subject");
    if (providerSubject.length > 256) throw new Error("Provider subject is too long");
    const userId = requiredString(input.userId, "New user ID");
    const identityId = requiredString(input.identityId, "New identity ID");
    const sessionId = requiredString(input.sessionId, "Session ID");
    const tokenHash = requireHash(input.tokenHash);
    const authPolicyVersion = requiredString(input.authPolicyVersion, "Auth policy version");
    const expiresAt = requireTimestamp(input.expiresAt, "Session expiry");
    return this._transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`auth-identity:${provider}:${providerSubject}`]);
      let identity = rows(await tx.query(
        `SELECT identity.user_id, user_record.role, user_record.status
           FROM auth_identity identity
           JOIN app_user user_record ON user_record.id = identity.user_id
          WHERE identity.provider = $1 AND identity.provider_subject = $2
          FOR UPDATE OF identity, user_record`,
        [provider, providerSubject]
      ))[0];
      let newUser = false;
      if (!identity) {
        oneRow(await tx.query(
          `INSERT INTO app_user (id, role, status)
           VALUES ($1, 'user', 'active')
           RETURNING id`,
          [userId]
        ), "App user could not be created");
        identity = oneRow(await tx.query(
          `INSERT INTO auth_identity (id, user_id, provider, provider_subject, last_login_at)
           VALUES ($1, $2, $3, $4, now())
           RETURNING user_id, 'user'::user_role AS role, 'active'::text AS status`,
          [identityId, userId, provider, providerSubject]
        ), "Auth identity could not be created");
        newUser = true;
      } else {
        await tx.query(
          `UPDATE auth_identity
              SET last_login_at = now()
            WHERE provider = $1 AND provider_subject = $2`,
          [provider, providerSubject]
        );
      }
      if (identity.status !== "active") throw new Error("Authenticated user is disabled");
      oneRow(await tx.query(
        `INSERT INTO auth_session (id, user_id, token_hash, expires_at, auth_policy_version)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [sessionId, identity.user_id, tokenHash, expiresAt, authPolicyVersion]
      ), "Auth session could not be created");
      await tx.query(
        `INSERT INTO audit_event (id, actor_id, event_type, metadata)
         VALUES ($1, $2, 'auth_session_created', $3::jsonb)`,
        [this.auditIdFactory(), identity.user_id, JSON.stringify({ provider, sessionId, authPolicyVersion, newUser })]
      );
      return { actor: { id: identity.user_id, role: identity.role }, newUser };
    });
  }

  async resolveSession({ tokenHash } = {}) {
    const hash = requireHash(tokenHash);
    return this._transaction(async (tx) => {
      const found = rows(await tx.query(
        `SELECT user_record.id, user_record.role, user_record.status
           FROM auth_session session_record
           JOIN app_user user_record ON user_record.id = session_record.user_id
          WHERE session_record.token_hash = $1
            AND session_record.revoked_at IS NULL
            AND session_record.expires_at > now()
          LIMIT 1`,
        [hash]
      ));
      if (!found.length || found[0].status !== "active") return null;
      return { id: found[0].id, role: found[0].role };
    });
  }

  async revokeSession({ tokenHash } = {}) {
    const hash = requireHash(tokenHash);
    return this._transaction(async (tx) => {
      const revoked = rows(await tx.query(
        `UPDATE auth_session
            SET revoked_at = COALESCE(revoked_at, now())
          WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING id, user_id`,
        [hash]
      ));
      if (!revoked.length) return { revoked: false };
      await tx.query(
        `INSERT INTO audit_event (id, actor_id, event_type, metadata)
         VALUES ($1, $2, 'auth_session_revoked', $3::jsonb)`,
        [this.auditIdFactory(), revoked[0].user_id, JSON.stringify({ sessionId: revoked[0].id })]
      );
      this.logger.info?.("petpack.auth.session_revoked", { userId: revoked[0].user_id });
      return { revoked: true };
    });
  }
}

module.exports = { PostgresAuthRepository };
