const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const {
  assertPositiveByteSize,
  assertPrivateObjectKey,
  normalizeSha256
} = require("./private-object-store");

const DEFAULT_MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const DEFAULT_SIGNED_TTL_SECONDS = 10 * 60;
const MAX_SIGNED_TTL_SECONDS = 60 * 60;
const SIGNED_PATH = "/v1/private-object";
const CONTENT_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]*)?$/;
const LOCAL_SEGMENT_FORBIDDEN_PATTERN = /[\u0000-\u001f<>:"|?*]/;
const TOKEN_FIELDS = Object.freeze({
  PUT: ["v", "method", "objectKey", "issuedAt", "expiresAt", "contentType", "expectedSha256", "expectedByteSize"],
  GET: ["v", "method", "objectKey", "issuedAt", "expiresAt", "disposition"]
});

class LocalPrivateObjectError extends Error {
  constructor(operation, { code = "local_object_request_failed", category = "request_failed" } = {}) {
    super(`Local private object ${operation} failed`);
    this.name = "LocalPrivateObjectError";
    this.operation = operation;
    this.code = code;
    this.category = category;
  }
}

function localError(operation, code, category) {
  return new LocalPrivateObjectError(operation, { code, category });
}

function asLocalError(operation, error) {
  if (error instanceof LocalPrivateObjectError) return error;
  if (error?.code === "ENOENT") return localError(operation, "object_not_found", "not_found");
  if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
    return localError(operation, "object_already_exists", "conflict");
  }
  return localError(operation, "local_object_request_failed", "request_failed");
}

function assertLocalOnly(environmentName) {
  const normalized = typeof environmentName === "string" ? environmentName.trim().toLowerCase() : "";
  if (normalized !== "development" && normalized !== "test") {
    throw localError("configure", "local_object_store_disabled", "access_denied");
  }
  return normalized;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function boundedPositiveInteger(value, fallback, maximum, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function booleanFlag(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "1" || value === "true") return true;
  if (value === false || value === "0" || value === "false") return false;
  throw new Error(`${label} must be true/false or 1/0`);
}

function normalizeContentType(value) {
  const normalized = requiredString(value, "Local object content type");
  if (normalized.length > 255 || !CONTENT_TYPE_PATTERN.test(normalized)) {
    throw new Error("Local object content type is invalid");
  }
  return normalized;
}

function normalizeDisposition(value = "attachment") {
  if (value !== "inline" && value !== "attachment") {
    throw new Error("Local object download disposition is invalid");
  }
  return value;
}

function normalizeObjectKey(objectKey) {
  const key = assertPrivateObjectKey(objectKey);
  if (key.length > 1024 || key.split("/").some((segment) => (
    segment.length > 128 || LOCAL_SEGMENT_FORBIDDEN_PATTERN.test(segment) || /[. ]$/.test(segment)
  ))) {
    throw new Error("Private object key cannot be represented safely on the local filesystem");
  }
  return key;
}

function sameResolvedPath(left, right) {
  const normalize = process.platform === "win32"
    ? (value) => path.resolve(value).toLowerCase()
    : (value) => path.resolve(value);
  return normalize(left) === normalize(right);
}

function isPathWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeRootDirectory(value) {
  const root = path.resolve(requiredString(value, "Local object root directory"));
  if (!path.isAbsolute(value) || sameResolvedPath(root, path.parse(root).root)) {
    throw new Error("Local object root must be an isolated absolute directory");
  }
  return root;
}

function normalizeSigningSecret(value) {
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(requiredString(value, "Local object signing secret"), "utf8");
  if (bytes.length < 32) throw new Error("Local object signing secret must contain at least 32 bytes");
  return bytes;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255) && Number(match[1]) === 127);
}

function normalizeLoopbackBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, "Local object base URL"));
  } catch {
    throw new Error("Local object base URL must be an absolute loopback HTTP URL");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "") || !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Local object base URL must be an absolute loopback HTTP URL");
  }
  return parsed.origin;
}

function normalizeAllowedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(requiredString(value, "Local object allowed origin"));
  } catch {
    throw new Error("Local object allowed origin must be an absolute loopback HTTP origin");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "") || !isLoopbackHostname(parsed.hostname)) {
    throw new Error("Local object allowed origin must be an absolute loopback HTTP origin");
  }
  return parsed.origin;
}

function asNodeReadable(body) {
  if (body instanceof Readable) return body;
  if (body && typeof body.getReader === "function") return Readable.fromWeb(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === "string") return Readable.from([body]);
  if (body && typeof body[Symbol.asyncIterator] === "function") return Readable.from(body);
  throw new Error("Local object body must be a buffer, string, or readable stream");
}

function objectHash(objectKey) {
  return crypto.createHash("sha256").update(objectKey, "utf8").digest("hex");
}

function etagFor(sha256) {
  return `"${normalizeSha256(sha256)}"`;
}

function metadataJson(metadata) {
  return `${JSON.stringify(metadata)}\n`;
}

function exactFields(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

async function lstatOrUndefined(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function requirePlainDirectory(target, operation) {
  const stat = await fsp.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw localError(operation, "unsafe_storage_path", "access_denied");
  }
  return stat;
}

async function requireRegularFile(target, operation) {
  const stat = await fsp.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw localError(operation, "unsafe_storage_path", "access_denied");
  }
  return stat;
}

function statIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    birthtimeMs: Number(stat.birthtimeMs)
  };
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.birthtimeMs === right.birthtimeMs;
}

async function inspectDirectoryChain(rootDirectory, targetDirectory, operation) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(targetDirectory);
  if (!isPathWithin(target, root)) {
    throw localError(operation, "unsafe_storage_path", "access_denied");
  }
  const relative = path.relative(root, target);
  const segments = relative ? relative.split(path.sep) : [];
  const chainPaths = [root];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    chainPaths.push(current);
  }
  const entries = [];
  for (const directory of chainPaths) {
    const stat = await requirePlainDirectory(directory, operation);
    const realDirectory = await fsp.realpath(directory);
    if (!sameResolvedPath(realDirectory, directory) || !isPathWithin(realDirectory, root)) {
      throw localError(operation, "unsafe_storage_path", "access_denied");
    }
    entries.push({ path: path.resolve(directory), realPath: path.resolve(realDirectory), identity: statIdentity(stat) });
  }
  return Object.freeze({ root, target, entries: Object.freeze(entries) });
}

function sameDirectoryChain(left, right) {
  return left.root === right.root && left.target === right.target && left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const candidate = right.entries[index];
      return sameResolvedPath(entry.path, candidate.path) && sameResolvedPath(entry.realPath, candidate.realPath) &&
        sameStatIdentity(entry.identity, candidate.identity);
    });
}

function directoryChainHasPrefix(chain, prefix) {
  return chain.entries.length >= prefix.entries.length && prefix.entries.every((entry, index) => {
    const candidate = chain.entries[index];
    return sameResolvedPath(entry.path, candidate.path) && sameResolvedPath(entry.realPath, candidate.realPath) &&
      sameStatIdentity(entry.identity, candidate.identity);
  });
}

async function requireUnchangedDirectoryChain(expected, operation) {
  let current;
  try {
    current = await inspectDirectoryChain(expected.root, expected.target, operation);
  } catch (error) {
    if (error instanceof LocalPrivateObjectError && error.category === "access_denied") throw error;
    throw localError(operation, "storage_path_changed", "access_denied");
  }
  if (!sameDirectoryChain(expected, current)) {
    throw localError(operation, "storage_path_changed", "access_denied");
  }
  return current;
}

async function openRegularFile(target, operation, { rootDirectory, parentChain } = {}) {
  const expectedParentChain = parentChain || await inspectDirectoryChain(rootDirectory, path.dirname(target), operation);
  await requireUnchangedDirectoryChain(expectedParentChain, operation);
  const pathStat = await requireRegularFile(target, operation);
  const realTarget = await fsp.realpath(target);
  if (!sameResolvedPath(realTarget, target) || !isPathWithin(realTarget, rootDirectory)) {
    throw localError(operation, "unsafe_storage_path", "access_denied");
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fsp.open(target, fs.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || !sameStatIdentity(statIdentity(pathStat), statIdentity(stat))) {
      throw localError(operation, "storage_path_changed", "access_denied");
    }
    await requireUnchangedDirectoryChain(expectedParentChain, operation);
    const finalPathStat = await requireRegularFile(target, operation);
    if (!sameStatIdentity(statIdentity(pathStat), statIdentity(finalPathStat))) {
      throw localError(operation, "storage_path_changed", "access_denied");
    }
    return { handle, stat, parentChain: expectedParentChain, fileIdentity: statIdentity(stat) };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "ELOOP") throw localError(operation, "unsafe_storage_path", "access_denied");
    throw error;
  }
}

async function requireOpenFileStillNamed(opened, target, rootDirectory, operation) {
  await requireUnchangedDirectoryChain(opened.parentChain, operation);
  const pathStat = await requireRegularFile(target, operation);
  const realTarget = await fsp.realpath(target);
  if (!sameResolvedPath(realTarget, target) || !isPathWithin(realTarget, rootDirectory) ||
      !sameStatIdentity(opened.fileIdentity, statIdentity(pathStat))) {
    throw localError(operation, "storage_path_changed", "access_denied");
  }
}

function digestingTransform(maximumBytes) {
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      byteSize += buffer.length;
      if (byteSize > maximumBytes) {
        callback(localError("put", "object_too_large", "object_too_large"));
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    }
  });
  return {
    stream,
    result() {
      return { byteSize, sha256: hash.digest("hex") };
    }
  };
}

class LocalPrivateObjectDriver {
  constructor({
    rootDirectory,
    signingSecret,
    baseUrl,
    environmentName = process.env.NODE_ENV,
    maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES,
    maxSignedTtlSeconds = MAX_SIGNED_TTL_SECONDS,
    now = () => Date.now(),
    testHooks
  } = {}) {
    this.environmentName = assertLocalOnly(environmentName);
    this.rootDirectory = normalizeRootDirectory(rootDirectory);
    this.signingSecret = normalizeSigningSecret(signingSecret);
    this.baseUrl = baseUrl === undefined ? undefined : normalizeLoopbackBaseUrl(baseUrl);
    this.maxObjectBytes = boundedPositiveInteger(maxObjectBytes, DEFAULT_MAX_OBJECT_BYTES, 1024 * 1024 * 1024, "Local object byte limit");
    this.maxSignedTtlSeconds = boundedPositiveInteger(maxSignedTtlSeconds, MAX_SIGNED_TTL_SECONDS, MAX_SIGNED_TTL_SECONDS, "Local signed URL TTL limit");
    if (typeof now !== "function") throw new Error("Local object clock must be a function");
    this.now = now;
    if (testHooks !== undefined) {
      if (this.environmentName !== "test" || !testHooks || typeof testHooks !== "object" || Array.isArray(testHooks) ||
          Object.values(testHooks).some((hook) => typeof hook !== "function")) {
        throw new Error("Local object test hooks are permitted only in test mode and must be functions");
      }
    }
    this.testHooks = testHooks ? { ...testHooks } : {};
    this.objectsDirectory = path.join(this.rootDirectory, "objects");
    this.stagingDirectory = path.join(this.rootDirectory, "staging");
    this.initialization = undefined;
  }

  async _runTestHook(name, context) {
    const hook = this.testHooks[name];
    if (hook) await hook(Object.freeze({ ...context }));
  }

  setBaseUrl(value) {
    const origin = normalizeLoopbackBaseUrl(value);
    if (this.baseUrl && this.baseUrl !== origin) {
      throw new Error("Local object base URL cannot change after configuration");
    }
    this.baseUrl = origin;
    return origin;
  }

  async initialize() {
    if (!this.initialization) this.initialization = this._initialize();
    return this.initialization;
  }

  async close() {
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) await server.close();
  }

  async _initialize() {
    const existingRoot = await lstatOrUndefined(this.rootDirectory);
    if (existingRoot && (!existingRoot.isDirectory() || existingRoot.isSymbolicLink())) {
      throw localError("initialize", "unsafe_storage_path", "access_denied");
    }
    await fsp.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await requirePlainDirectory(this.rootDirectory, "initialize");
    const realRoot = await fsp.realpath(this.rootDirectory);
    if (!sameResolvedPath(realRoot, this.rootDirectory)) {
      throw localError("initialize", "unsafe_storage_path", "access_denied");
    }
    for (const directory of [this.objectsDirectory, this.stagingDirectory]) {
      await fsp.mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await requirePlainDirectory(directory, "initialize");
      const realDirectory = await fsp.realpath(directory);
      if (!isPathWithin(realDirectory, realRoot)) {
        throw localError("initialize", "unsafe_storage_path", "access_denied");
      }
    }
    return this;
  }

  _recordPaths(objectKey) {
    const key = normalizeObjectKey(objectKey);
    const digest = objectHash(key);
    const shardDirectory = path.join(this.objectsDirectory, digest.slice(0, 2));
    const recordDirectory = path.join(shardDirectory, digest);
    if (!isPathWithin(recordDirectory, this.objectsDirectory)) {
      throw localError("resolve", "unsafe_storage_path", "access_denied");
    }
    return {
      objectKey: key,
      digest,
      shardDirectory,
      recordDirectory,
      bodyPath: path.join(recordDirectory, "body"),
      metadataPath: path.join(recordDirectory, "metadata.json")
    };
  }

  async _prepareShard(paths, operation) {
    await this.initialize();
    await fsp.mkdir(paths.shardDirectory, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    return inspectDirectoryChain(this.rootDirectory, paths.shardDirectory, operation);
  }

  _ttl(value) {
    return boundedPositiveInteger(value, DEFAULT_SIGNED_TTL_SECONDS, this.maxSignedTtlSeconds, "Local signed URL TTL");
  }

  _sign(token) {
    return crypto.createHmac("sha256", this.signingSecret).update(token, "utf8").digest("hex");
  }

  _signedUrl(payload) {
    if (!this.baseUrl) throw new Error("Local object base URL must be configured before signing URLs");
    const token = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const url = new URL(SIGNED_PATH, this.baseUrl);
    url.searchParams.set("token", token);
    url.searchParams.set("signature", this._sign(token));
    return url.toString();
  }

  _grantPayload(method, objectKey, expiresInSeconds, fields) {
    const issuedAt = Math.floor(Number(this.now()) / 1000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("Local object clock returned an invalid time");
    const ttl = this._ttl(expiresInSeconds);
    return {
      v: 1,
      method,
      objectKey: normalizeObjectKey(objectKey),
      issuedAt,
      expiresAt: issuedAt + ttl,
      ...fields
    };
  }

  createSignedUpload({ objectKey, contentType, expectedSha256, expectedByteSize, expiresInSeconds } = {}) {
    const normalizedType = normalizeContentType(contentType);
    const digest = normalizeSha256(expectedSha256, "Expected local upload checksum");
    const byteSize = assertPositiveByteSize(Number(expectedByteSize), "Expected local upload byte size");
    if (byteSize > this.maxObjectBytes) throw localError("sign", "object_too_large", "object_too_large");
    const payload = this._grantPayload("PUT", objectKey, expiresInSeconds, {
      contentType: normalizedType,
      expectedSha256: digest,
      expectedByteSize: byteSize
    });
    return {
      url: this._signedUrl(payload),
      headers: { "content-type": normalizedType, "if-none-match": "*" }
    };
  }

  createSignedDownload({ objectKey, expiresInSeconds, disposition = "attachment" } = {}) {
    const payload = this._grantPayload("GET", objectKey, expiresInSeconds, {
      disposition: normalizeDisposition(disposition)
    });
    return { url: this._signedUrl(payload) };
  }

  verifySignedRequest(url, { method } = {}) {
    let parsed;
    try {
      parsed = url instanceof URL ? url : new URL(url, this.baseUrl || "http://127.0.0.1");
    } catch {
      throw localError("authorize", "invalid_signature", "access_denied");
    }
    if (parsed.pathname !== SIGNED_PATH || parsed.searchParams.size !== 2 ||
        parsed.searchParams.getAll("token").length !== 1 || parsed.searchParams.getAll("signature").length !== 1) {
      throw localError("authorize", "invalid_signature", "access_denied");
    }
    const token = parsed.searchParams.get("token");
    const signature = parsed.searchParams.get("signature");
    if (!token || token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token) || !/^[a-f0-9]{64}$/.test(signature || "")) {
      throw localError("authorize", "invalid_signature", "access_denied");
    }
    const expectedSignature = Buffer.from(this._sign(token), "hex");
    const suppliedSignature = Buffer.from(signature, "hex");
    if (expectedSignature.length !== suppliedSignature.length || !crypto.timingSafeEqual(expectedSignature, suppliedSignature)) {
      throw localError("authorize", "invalid_signature", "access_denied");
    }
    let payload;
    try {
      const decoded = Buffer.from(token, "base64url");
      if (decoded.toString("base64url") !== token) throw new Error("non-canonical token");
      payload = JSON.parse(decoded.toString("utf8"));
    } catch {
      throw localError("authorize", "invalid_signature", "access_denied");
    }
    const expectedFields = TOKEN_FIELDS[payload?.method];
    if (!expectedFields || !exactFields(payload, expectedFields) || payload.v !== 1 ||
        (method !== undefined && payload.method !== method)) {
      throw localError("authorize", "invalid_signature", "access_denied");
    }
    normalizeObjectKey(payload.objectKey);
    const nowSeconds = Math.floor(Number(this.now()) / 1000);
    if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
        payload.issuedAt < 0 || payload.expiresAt <= payload.issuedAt ||
        payload.expiresAt - payload.issuedAt > this.maxSignedTtlSeconds ||
        payload.issuedAt > nowSeconds + 30 || payload.expiresAt <= nowSeconds ||
        payload.expiresAt > nowSeconds + this.maxSignedTtlSeconds + 30) {
      throw localError("authorize", "expired_or_invalid_grant", "access_denied");
    }
    if (payload.method === "PUT") {
      payload.contentType = normalizeContentType(payload.contentType);
      payload.expectedSha256 = normalizeSha256(payload.expectedSha256, "Expected local upload checksum");
      payload.expectedByteSize = assertPositiveByteSize(Number(payload.expectedByteSize), "Expected local upload byte size");
      if (payload.expectedByteSize > this.maxObjectBytes) {
        throw localError("authorize", "object_too_large", "object_too_large");
      }
    } else {
      payload.disposition = normalizeDisposition(payload.disposition);
    }
    return Object.freeze(payload);
  }

  async _readMetadata(paths, operation) {
    await this.initialize();
    const recordChain = await inspectDirectoryChain(this.rootDirectory, paths.recordDirectory, operation);
    await this._runTestHook("readBeforeMetadataOpen", { paths });
    await requireUnchangedDirectoryChain(recordChain, operation);
    let metadata;
    let openedMetadata;
    try {
      openedMetadata = await openRegularFile(paths.metadataPath, operation, {
        rootDirectory: this.rootDirectory,
        parentChain: recordChain
      });
      const raw = await openedMetadata.handle.readFile("utf8");
      await requireOpenFileStillNamed(openedMetadata, paths.metadataPath, this.rootDirectory, operation);
      if (Buffer.byteLength(raw, "utf8") > 4096) throw new Error("metadata too large");
      metadata = JSON.parse(raw);
    } catch (error) {
      if (error instanceof LocalPrivateObjectError) throw error;
      throw localError(operation, "invalid_object_metadata", "invalid_response");
    } finally {
      await openedMetadata?.handle.close().catch(() => {});
    }
    if (!exactFields(metadata, ["v", "objectKey", "contentType", "byteSize", "sha256", "createdAt"]) ||
        metadata.v !== 1 || metadata.objectKey !== paths.objectKey) {
      throw localError(operation, "invalid_object_metadata", "invalid_response");
    }
    try {
      return {
        metadata: {
          objectKey: paths.objectKey,
          contentType: normalizeContentType(metadata.contentType),
          byteSize: assertPositiveByteSize(Number(metadata.byteSize), "Local object byte size"),
          sha256: normalizeSha256(metadata.sha256, "Local object checksum")
        },
        recordChain
      };
    } catch {
      throw localError(operation, "invalid_object_metadata", "invalid_response");
    }
  }

  async headPrivate({ objectKey } = {}) {
    const paths = this._recordPaths(objectKey);
    try {
      const { metadata, recordChain } = await this._readMetadata(paths, "head");
      await this._runTestHook("readBeforeBodyOpen", { paths });
      await requireUnchangedDirectoryChain(recordChain, "head");
      const opened = await openRegularFile(paths.bodyPath, "head", {
        rootDirectory: this.rootDirectory,
        parentChain: recordChain
      });
      const stat = opened.stat;
      if (!Number.isSafeInteger(stat.size) || stat.size !== metadata.byteSize || stat.size > this.maxObjectBytes) {
        await opened.handle.close().catch(() => {});
        throw localError("head", "object_metadata_changed", "object_changed");
      }
      const hash = crypto.createHash("sha256");
      let byteSize = 0;
      try {
        for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
          byteSize += chunk.length;
          if (byteSize > metadata.byteSize) throw localError("head", "object_metadata_changed", "object_changed");
          hash.update(chunk);
        }
      } finally {
        await opened.handle.close().catch(() => {});
      }
      await requireOpenFileStillNamed(opened, paths.bodyPath, this.rootDirectory, "head");
      if (byteSize !== metadata.byteSize || hash.digest("hex") !== metadata.sha256) {
        throw localError("head", "object_metadata_changed", "object_changed");
      }
      return metadata;
    } catch (error) {
      throw asLocalError("head", error);
    }
  }

  async getPrivate({ objectKey } = {}) {
    const paths = this._recordPaths(objectKey);
    try {
      const metadata = await this.headPrivate({ objectKey: paths.objectKey });
      const recordChain = await inspectDirectoryChain(this.rootDirectory, paths.recordDirectory, "get");
      await this._runTestHook("readBeforeGetBodyOpen", { paths });
      await requireUnchangedDirectoryChain(recordChain, "get");
      const opened = await openRegularFile(paths.bodyPath, "get", {
        rootDirectory: this.rootDirectory,
        parentChain: recordChain
      });
      if (opened.stat.size !== metadata.byteSize) {
        await opened.handle.close().catch(() => {});
        throw localError("get", "object_metadata_changed", "object_changed");
      }
      const source = opened.handle.createReadStream();
      const hash = crypto.createHash("sha256");
      const rootDirectory = this.rootDirectory;
      let byteSize = 0;
      const guarded = new Transform({
        transform(chunk, encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
          byteSize += buffer.length;
          if (byteSize > metadata.byteSize) {
            callback(localError("get", "object_metadata_changed", "object_changed"));
            return;
          }
          hash.update(buffer);
          callback(null, buffer);
        },
        flush(callback) {
          if (byteSize !== metadata.byteSize || hash.digest("hex") !== metadata.sha256) {
            callback(localError("get", "object_metadata_changed", "object_changed"));
            return;
          }
          requireOpenFileStillNamed(opened, paths.bodyPath, rootDirectory, "get").then(
            () => callback(),
            (error) => callback(error)
          );
        }
      });
      source.once("error", (error) => guarded.destroy(asLocalError("get", error)));
      guarded.once("error", () => source.destroy());
      guarded.once("close", () => source.destroy());
      source.pipe(guarded);
      return { ...metadata, body: guarded };
    } catch (error) {
      throw asLocalError("get", error);
    }
  }

  async _cleanupOwnedStaging(stagingPath, stagingChain) {
    if (!stagingPath || !stagingChain || !sameResolvedPath(path.dirname(stagingPath), this.stagingDirectory) ||
        !path.basename(stagingPath).startsWith("object-")) return;
    try {
      const existing = await lstatOrUndefined(stagingPath);
      if (!existing) return;
      const current = await inspectDirectoryChain(this.rootDirectory, stagingPath, "cleanup");
      if (!sameDirectoryChain(stagingChain, current)) return;
      await fsp.rm(stagingPath, { recursive: true, force: false });
    } catch {
      // Fail closed: never remove a path whose parent chain or identity changed.
    }
  }

  async putPrivate({ objectKey, body, contentType, sha256, byteSize, ifNoneMatch } = {}) {
    const paths = this._recordPaths(objectKey);
    const normalizedType = normalizeContentType(contentType);
    if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
      throw new Error("Local object If-None-Match must be '*' when supplied");
    }
    const expectedSha256 = sha256 === undefined ? undefined : normalizeSha256(sha256, "Expected local object checksum");
    const expectedByteSize = byteSize === undefined ? undefined : assertPositiveByteSize(Number(byteSize), "Expected local object byte size");
    if (expectedByteSize !== undefined && expectedByteSize > this.maxObjectBytes) {
      throw localError("put", "object_too_large", "object_too_large");
    }
    const shardChain = await this._prepareShard(paths, "put");
    const stagingParentChain = await inspectDirectoryChain(this.rootDirectory, this.stagingDirectory, "put");
    await requireUnchangedDirectoryChain(stagingParentChain, "put");
    const stagingPath = await fsp.mkdtemp(path.join(this.stagingDirectory, "object-"));
    let stagingChain;
    const stagedBodyPath = path.join(stagingPath, "body");
    const stagedMetadataPath = path.join(stagingPath, "metadata.json");
    try {
      stagingChain = await inspectDirectoryChain(this.rootDirectory, stagingPath, "put");
      if (!directoryChainHasPrefix(stagingChain, stagingParentChain)) {
        throw localError("put", "storage_path_changed", "access_denied");
      }
      const digest = digestingTransform(this.maxObjectBytes);
      await requireUnchangedDirectoryChain(stagingChain, "put");
      await pipeline(
        asNodeReadable(body),
        digest.stream,
        fs.createWriteStream(stagedBodyPath, { flags: "wx", mode: 0o600 })
      );
      await requireUnchangedDirectoryChain(stagingChain, "put");
      const actual = digest.result();
      if (actual.byteSize <= 0) throw localError("put", "empty_object", "invalid_request");
      if ((expectedSha256 !== undefined && actual.sha256 !== expectedSha256) ||
          (expectedByteSize !== undefined && actual.byteSize !== expectedByteSize)) {
        throw localError("put", "object_integrity_mismatch", "invalid_request");
      }
      const metadata = {
        v: 1,
        objectKey: paths.objectKey,
        contentType: normalizedType,
        byteSize: actual.byteSize,
        sha256: actual.sha256,
        createdAt: new Date(Number(this.now())).toISOString()
      };
      await fsp.writeFile(stagedMetadataPath, metadataJson(metadata), { flag: "wx", mode: 0o600 });
      await requireUnchangedDirectoryChain(stagingChain, "put");
      const openedBody = await openRegularFile(stagedBodyPath, "put", {
        rootDirectory: this.rootDirectory,
        parentChain: stagingChain
      });
      const bodyIdentity = openedBody.fileIdentity;
      await openedBody.handle.close();
      const openedMetadata = await openRegularFile(stagedMetadataPath, "put", {
        rootDirectory: this.rootDirectory,
        parentChain: stagingChain
      });
      const metadataIdentity = openedMetadata.fileIdentity;
      await openedMetadata.handle.close();
      await this._runTestHook("putBeforeFinalParentCheck", { paths, stagingPath });
      await requireUnchangedDirectoryChain(shardChain, "put");
      await requireUnchangedDirectoryChain(stagingChain, "put");
      let renamed = false;
      try {
        await fsp.rename(stagingPath, paths.recordDirectory);
        renamed = true;
        await this._runTestHook("putAfterRenameBeforeValidation", { paths });
        await requireUnchangedDirectoryChain(shardChain, "put");
        const recordChain = await inspectDirectoryChain(this.rootDirectory, paths.recordDirectory, "put");
        if (!directoryChainHasPrefix(recordChain, shardChain)) {
          throw localError("put", "storage_path_changed", "access_denied");
        }
        const finalBodyStat = await requireRegularFile(paths.bodyPath, "put");
        const finalMetadataStat = await requireRegularFile(paths.metadataPath, "put");
        if (!sameStatIdentity(bodyIdentity, statIdentity(finalBodyStat)) ||
            !sameStatIdentity(metadataIdentity, statIdentity(finalMetadataStat))) {
          throw localError("put", "storage_path_changed", "access_denied");
        }
        const trusted = await this.headPrivate({ objectKey: paths.objectKey });
        if (trusted.contentType !== normalizedType || trusted.byteSize !== actual.byteSize || trusted.sha256 !== actual.sha256) {
          throw localError("put", "object_metadata_changed", "object_changed");
        }
        return {
          objectKey: paths.objectKey,
          contentType: normalizedType,
          byteSize: actual.byteSize,
          sha256: actual.sha256
        };
      } catch (error) {
        if (renamed) throw error;
        await requireUnchangedDirectoryChain(shardChain, "put");
        const existing = await lstatOrUndefined(paths.recordDirectory);
        if (!existing) throw error;
        if (ifNoneMatch === "*") {
          throw localError("put", "precondition_failed", "conflict");
        }
        const current = await this.headPrivate({ objectKey: paths.objectKey });
        if (current.contentType === normalizedType && current.byteSize === actual.byteSize && current.sha256 === actual.sha256) {
          return current;
        }
        throw localError("put", "object_already_exists", "conflict");
      }
    } catch (error) {
      throw asLocalError("put", error);
    } finally {
      await this._cleanupOwnedStaging(stagingPath, stagingChain);
    }
  }
}

function requestOriginAllowed(origin, allowedOrigins) {
  return !origin || allowedOrigins.has(origin);
}

function writeJson(response, statusCode, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(body);
}

function httpStatusFor(error) {
  if (!(error instanceof LocalPrivateObjectError)) return 500;
  if (error.code === "object_not_found") return 404;
  if (error.code === "precondition_failed" || error.code === "object_already_exists") return 412;
  if (error.code === "object_integrity_mismatch" || error.code === "empty_object") return 422;
  if (error.code === "object_too_large") return 413;
  if (error.category === "access_denied") return 403;
  if (error.category === "invalid_request") return 400;
  return 500;
}

class LocalPrivateObjectHttpServer {
  constructor({ driver, allowedOrigins = [] } = {}) {
    if (!(driver instanceof LocalPrivateObjectDriver)) {
      throw new Error("Local object HTTP server requires a LocalPrivateObjectDriver");
    }
    this.driver = driver;
    this.allowedOrigins = new Set(allowedOrigins.map(normalizeAllowedOrigin));
    this.server = undefined;
    this.origin = undefined;
  }

  async start({ host = "127.0.0.1", port = 0 } = {}) {
    if (this.server) throw new Error("Local object HTTP server is already running");
    if (host !== "127.0.0.1" && host !== "::1") {
      throw new Error("Local object HTTP server may bind only to an explicit loopback address");
    }
    if (!Number.isSafeInteger(Number(port)) || Number(port) < 0 || Number(port) > 65535) {
      throw new Error("Local object HTTP server port is invalid");
    }
    await this.driver.initialize();
    const server = http.createServer((request, response) => {
      this._handle(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        writeJson(response, httpStatusFor(error), {
          error: error instanceof LocalPrivateObjectError ? error.code : "internal_error"
        });
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 32;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(port), host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
    this.origin = `http://${urlHost}:${address.port}`;
    try {
      this.driver.setBaseUrl(this.origin);
    } catch (error) {
      await this.close();
      throw error;
    }
    return { origin: this.origin, host: address.address, port: address.port };
  }

  _corsHeaders(request) {
    const origin = request.headers.origin;
    if (!origin) return {};
    if (!requestOriginAllowed(origin, this.allowedOrigins)) {
      throw localError("authorize", "origin_not_allowed", "access_denied");
    }
    return {
      "access-control-allow-origin": origin,
      vary: "Origin"
    };
  }

  _requestUrl(request) {
    const authority = request.headers.host || "127.0.0.1";
    return new URL(request.url, `http://${authority}`);
  }

  async _handle(request, response) {
    const corsHeaders = this._corsHeaders(request);
    const url = this._requestUrl(request);
    if (request.method === "OPTIONS") {
      const tokenPayload = this.driver.verifySignedRequest(url);
      response.writeHead(204, {
        ...corsHeaders,
        "access-control-allow-methods": tokenPayload.method,
        "access-control-allow-headers": "content-type, if-none-match",
        "access-control-max-age": String(Math.min(600, tokenPayload.expiresAt - Math.floor(Number(this.driver.now()) / 1000))),
        "cache-control": "no-store"
      });
      response.end();
      return;
    }
    if (request.method !== "PUT" && request.method !== "GET") {
      throw localError("authorize", "method_not_allowed", "access_denied");
    }
    const payload = this.driver.verifySignedRequest(url, { method: request.method });
    if (payload.method === "PUT") {
      const requestType = normalizeContentType(request.headers["content-type"]);
      if (requestType.toLowerCase() !== payload.contentType.toLowerCase()) {
        throw localError("put", "content_type_mismatch", "invalid_request");
      }
      const ifNoneMatch = request.headers["if-none-match"];
      if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
        throw localError("put", "invalid_if_none_match", "invalid_request");
      }
      const contentLength = request.headers["content-length"];
      if (contentLength !== undefined && (!/^[1-9][0-9]*$/.test(contentLength) || Number(contentLength) !== payload.expectedByteSize)) {
        throw localError("put", "content_length_mismatch", "invalid_request");
      }
      const stored = await this.driver.putPrivate({
        objectKey: payload.objectKey,
        body: request,
        contentType: payload.contentType,
        sha256: payload.expectedSha256,
        byteSize: payload.expectedByteSize,
        ifNoneMatch: "*"
      });
      writeJson(response, 201, {
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256
      }, { ...corsHeaders, etag: etagFor(stored.sha256) });
      return;
    }

    const downloaded = await this.driver.getPrivate({ objectKey: payload.objectKey });
    const etag = etagFor(downloaded.sha256);
    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch === "*" || ifNoneMatch === etag) {
      downloaded.body.destroy();
      response.writeHead(304, { ...corsHeaders, etag, "cache-control": "private, no-store" });
      response.end();
      return;
    }
    response.writeHead(200, {
      ...corsHeaders,
      "content-type": downloaded.contentType,
      "content-length": String(downloaded.byteSize),
      "content-disposition": payload.disposition,
      "cache-control": "private, no-store",
      etag,
      "x-content-type-options": "nosniff"
    });
    await pipeline(downloaded.body, response);
  }

  async close() {
    const server = this.server;
    this.server = undefined;
    this.origin = undefined;
    if (!server) return;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function loadLocalPrivateObjectConfig(environment = process.env) {
  const environmentName = assertLocalOnly(environment.NODE_ENV);
  return Object.freeze({
    environmentName,
    rootDirectory: normalizeRootDirectory(environment.PETPACK_LOCAL_OBJECT_ROOT),
    signingSecret: requiredString(environment.PETPACK_LOCAL_OBJECT_SIGNING_SECRET, "Local object signing secret"),
    baseUrl: normalizeLoopbackBaseUrl(environment.PETPACK_LOCAL_OBJECT_BASE_URL),
    maxObjectBytes: boundedPositiveInteger(
      environment.PETPACK_LOCAL_OBJECT_MAX_BYTES,
      DEFAULT_MAX_OBJECT_BYTES,
      1024 * 1024 * 1024,
      "Local object byte limit"
    ),
    maxSignedTtlSeconds: boundedPositiveInteger(
      environment.PETPACK_LOCAL_OBJECT_MAX_SIGNED_TTL_SECONDS,
      MAX_SIGNED_TTL_SECONDS,
      MAX_SIGNED_TTL_SECONDS,
      "Local signed URL TTL limit"
    )
  });
}

async function createLocalPrivateObjectDriver({ environment = process.env, logger = console, ...overrides } = {}) {
  const config = loadLocalPrivateObjectConfig(environment);
  const driver = new LocalPrivateObjectDriver({ ...config, ...overrides });
  await driver.initialize();
  const serveHttp = booleanFlag(environment.PETPACK_LOCAL_OBJECT_SERVE, false, "Local object HTTP serve flag");
  if (!serveHttp) return driver;

  const parsedBaseUrl = new URL(driver.baseUrl);
  const host = parsedBaseUrl.hostname === "[::1]" ? "::1" : parsedBaseUrl.hostname;
  const port = parsedBaseUrl.port ? Number(parsedBaseUrl.port) : 80;
  if ((host !== "127.0.0.1" && host !== "::1") || port === 80) {
    throw new Error("Serving local objects requires a fixed 127.0.0.1 or ::1 URL with an explicit non-default port");
  }
  const allowedOrigins = requiredString(
    environment.PETPACK_LOCAL_OBJECT_ALLOWED_ORIGINS || "http://127.0.0.1:3000,http://localhost:3000",
    "Local object allowed origins"
  ).split(",").map((origin) => origin.trim()).filter(Boolean);
  const server = new LocalPrivateObjectHttpServer({ driver, allowedOrigins, logger });
  try {
    await server.start({ host, port });
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
  driver.httpServer = server;
  return driver;
}

module.exports = {
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_SIGNED_TTL_SECONDS,
  MAX_SIGNED_TTL_SECONDS,
  SIGNED_PATH,
  LocalPrivateObjectDriver,
  LocalPrivateObjectError,
  LocalPrivateObjectHttpServer,
  createLocalPrivateObjectDriver,
  loadLocalPrivateObjectConfig,
  normalizeLoopbackBaseUrl
};
