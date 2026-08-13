const crypto = require("node:crypto");

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,256}$/;

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireRepository(repository) {
  const methods = ["createSessionForExternalIdentity", "resolveSession", "revokeSession"];
  const missing = methods.filter((method) => !repository || typeof repository[method] !== "function");
  if (missing.length) throw new Error(`Auth repository is incomplete: ${missing.join(", ")}`);
  return repository;
}

function requireVerifier(identityVerifier) {
  if (!identityVerifier || typeof identityVerifier.verifyAccessToken !== "function") {
    throw new Error("A CloudBase identity verifier is required");
  }
  return identityVerifier;
}

function sessionTokenHash(token, signingKey) {
  const value = requiredString(token, "Session token");
  if (!SESSION_TOKEN_PATTERN.test(value)) throw new Error("Session token is invalid");
  const key = requiredString(signingKey, "Session signing key");
  if (key.length < 32) throw new Error("Session signing key must contain at least 32 characters");
  return crypto.createHmac("sha256", key).update(value, "utf8").digest("hex");
}

class PhoneAuthService {
  constructor({
    identityVerifier,
    repository,
    sessionSigningKey,
    authPolicyVersion,
    sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
    idFactory = crypto.randomUUID,
    tokenFactory = () => crypto.randomBytes(32).toString("base64url"),
    now = () => new Date(),
    logger = console
  } = {}) {
    this.identityVerifier = requireVerifier(identityVerifier);
    this.repository = requireRepository(repository);
    this.sessionSigningKey = requiredString(sessionSigningKey, "Session signing key");
    if (this.sessionSigningKey.length < 32) throw new Error("Session signing key must contain at least 32 characters");
    this.authPolicyVersion = requiredString(authPolicyVersion, "Auth policy version");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(this.authPolicyVersion)) throw new Error("Auth policy version is invalid");
    if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 900 || sessionTtlSeconds > 90 * 24 * 60 * 60) {
      throw new Error("Session TTL must be between 15 minutes and 90 days");
    }
    if (typeof idFactory !== "function" || typeof tokenFactory !== "function" || typeof now !== "function") {
      throw new Error("Auth ID, token, and clock factories are required");
    }
    this.sessionTtlSeconds = sessionTtlSeconds;
    this.idFactory = idFactory;
    this.tokenFactory = tokenFactory;
    this.now = now;
    this.logger = logger;
  }

  _tokenHash(token) {
    return sessionTokenHash(token, this.sessionSigningKey);
  }

  async exchangeCloudBaseAccessToken({ accessToken } = {}) {
    const identity = await this.identityVerifier.verifyAccessToken(accessToken);
    if (identity.provider !== "TENCENT_CLOUDBASE" || identity.phoneVerified !== true) {
      throw new Error("A verified CloudBase phone identity is required");
    }
    const issuedAt = this.now();
    if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) throw new Error("Auth clock returned an invalid time");
    const expiresAt = new Date(issuedAt.getTime() + this.sessionTtlSeconds * 1000);
    const sessionToken = requiredString(this.tokenFactory(), "Generated session token");
    if (!SESSION_TOKEN_PATTERN.test(sessionToken)) throw new Error("Generated session token is invalid");
    const result = await this.repository.createSessionForExternalIdentity({
      provider: identity.provider,
      providerSubject: identity.subject,
      userId: this.idFactory(),
      identityId: this.idFactory(),
      sessionId: this.idFactory(),
      tokenHash: this._tokenHash(sessionToken),
      authPolicyVersion: this.authPolicyVersion,
      expiresAt: expiresAt.toISOString()
    });
    this.logger.info?.("petpack.auth.session_created", {
      userId: result.actor.id,
      provider: identity.provider,
      newUser: result.newUser === true
    });
    return { sessionToken, expiresAt: expiresAt.toISOString() };
  }

  async resolveSessionToken(sessionToken) {
    if (typeof sessionToken !== "string" || !SESSION_TOKEN_PATTERN.test(sessionToken)) return null;
    return this.repository.resolveSession({ tokenHash: this._tokenHash(sessionToken) });
  }

  async revokeSessionToken(sessionToken) {
    if (typeof sessionToken !== "string" || !SESSION_TOKEN_PATTERN.test(sessionToken)) return { revoked: false };
    const result = await this.repository.revokeSession({ tokenHash: this._tokenHash(sessionToken) });
    return { revoked: result && result.revoked === true };
  }
}

function readCookieValue(rawCookie, cookieName) {
  if (typeof rawCookie !== "string" || /[\r\n]/.test(rawCookie)) return null;
  const safeName = requiredString(cookieName, "Session cookie name");
  for (const part of rawCookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== safeName) continue;
    const value = part.slice(separator + 1).trim();
    return SESSION_TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

function requestHeader(request, name) {
  const headers = request && request.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) || undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry && entry[1];
}

function createSessionActorResolver({ authService, cookieName } = {}) {
  if (!authService || typeof authService.resolveSessionToken !== "function") throw new Error("An auth service is required");
  const safeCookieName = requiredString(cookieName, "Session cookie name");
  return async ({ request } = {}) => {
    const token = readCookieValue(requestHeader(request, "cookie"), safeCookieName);
    return token ? authService.resolveSessionToken(token) : null;
  };
}

module.exports = {
  DEFAULT_SESSION_TTL_SECONDS,
  PhoneAuthService,
  SESSION_TOKEN_PATTERN,
  createSessionActorResolver,
  readCookieValue,
  sessionTokenHash
};
