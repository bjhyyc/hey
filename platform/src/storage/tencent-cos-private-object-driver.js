const crypto = require("node:crypto");
const { Readable, Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const COS = require("cos-nodejs-sdk-v5");
const { assertPrivateObjectKey } = require("./private-object-store");

const DEFAULT_MAX_VERIFIED_OBJECT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_OBJECT_BYTES = 256 * 1024 * 1024;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}-[0-9]{5,20}$/;
const REGION_PATTERN = /^ap-[a-z0-9-]{2,40}$/;

class TencentCosPrivateObjectError extends Error {
  constructor(operation, cause) {
    super(`Tencent COS ${operation} failed`);
    this.name = "TencentCosPrivateObjectError";
    this.operation = operation;
    this.code = typeof cause?.code === "string" ? cause.code : "cos_request_failed";
    this.statusCode = Number.isSafeInteger(cause?.statusCode) ? cause.statusCode : undefined;
    this.requestId = typeof cause?.RequestId === "string" ? cause.RequestId : undefined;
  }
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

function loadTencentCosConfig(environment = process.env) {
  const endpoint = requiredString(environment.PETPACK_OBJECT_STORE_ENDPOINT, "COS endpoint");
  const bucket = requiredString(environment.PETPACK_OBJECT_STORE_BUCKET, "COS bucket");
  const region = requiredString(environment.PETPACK_OBJECT_STORE_REGION, "COS region");
  const secretId = requiredString(environment.PETPACK_OBJECT_STORE_ACCESS_KEY_ID, "COS SecretId");
  const secretKey = requiredString(environment.PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY, "COS SecretKey");
  if (!BUCKET_PATTERN.test(bucket)) throw new Error("COS bucket name is invalid");
  if (!REGION_PATTERN.test(region)) throw new Error("COS region is invalid");
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("COS endpoint must be an absolute HTTPS URL");
  }
  const expectedHost = `${bucket}.cos.${region}.myqcloud.com`;
  if (parsedEndpoint.protocol !== "https:" || parsedEndpoint.username || parsedEndpoint.password ||
      parsedEndpoint.pathname !== "/" || parsedEndpoint.search || parsedEndpoint.hash ||
      parsedEndpoint.hostname !== expectedHost || parsedEndpoint.port) {
    throw new Error("COS endpoint does not match the configured bucket and region");
  }
  return Object.freeze({
    endpoint: parsedEndpoint.origin,
    bucket,
    region,
    secretId,
    secretKey,
    maxVerifiedObjectBytes: boundedPositiveInteger(
      environment.PETPACK_COS_MAX_VERIFIED_OBJECT_BYTES,
      DEFAULT_MAX_VERIFIED_OBJECT_BYTES,
      128 * 1024 * 1024,
      "COS verified-object byte limit"
    ),
    maxArchiveObjectBytes: boundedPositiveInteger(
      environment.PETPACK_COS_MAX_ARCHIVE_OBJECT_BYTES,
      DEFAULT_MAX_ARCHIVE_OBJECT_BYTES,
      1024 * 1024 * 1024,
      "COS archive byte limit"
    )
  });
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  return undefined;
}

function safeDisposition(value) {
  if (value !== "inline" && value !== "attachment") throw new Error("COS download disposition is invalid");
  return value;
}

function asNodeReadable(body) {
  if (body instanceof Readable) return body;
  if (body && typeof body.getReader === "function") return Readable.fromWeb(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === "string") return Readable.from([body]);
  throw new Error("COS upload body must be a buffer, string, or readable stream");
}

function digestingTransform(maximumBytes) {
  const hash = crypto.createHash("sha256");
  let byteSize = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      byteSize += buffer.length;
      if (byteSize > maximumBytes) {
        callback(new Error("COS archive object exceeds the configured byte limit"));
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    }
  });
  return {
    stream,
    result() {
      return { sha256: hash.digest("hex"), byteSize };
    }
  };
}

async function cosOperation(operation, task) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof TencentCosPrivateObjectError) throw error;
    throw new TencentCosPrivateObjectError(operation, error);
  }
}

class TencentCosPrivateObjectDriver {
  constructor({ config, cosClient, CosClass = COS } = {}) {
    if (!config || typeof config !== "object") throw new Error("Tencent COS configuration is required");
    this.config = config;
    this.cos = cosClient || new CosClass({ SecretId: config.secretId, SecretKey: config.secretKey });
    for (const method of ["getObjectUrl", "headObject", "getObject", "putObject"]) {
      if (typeof this.cos?.[method] !== "function") throw new Error(`Tencent COS client must implement ${method}`);
    }
  }

  objectParams(objectKey) {
    return {
      Bucket: this.config.bucket,
      Region: this.config.region,
      Key: assertPrivateObjectKey(objectKey)
    };
  }

  async signedUrl(params) {
    return cosOperation("sign", () => new Promise((resolve, reject) => {
      this.cos.getObjectUrl(params, (error, data) => {
        if (error) reject(error);
        else if (!data || typeof data.Url !== "string" || !data.Url.startsWith("https://")) {
          reject(new Error("COS returned an invalid signed URL"));
        } else resolve(data.Url);
      });
    }));
  }

  async createSignedUpload({ objectKey, contentType, expiresInSeconds } = {}) {
    const normalizedType = requiredString(contentType, "COS upload content type");
    const url = await this.signedUrl({
      ...this.objectParams(objectKey),
      Sign: true,
      Method: "PUT",
      Protocol: "https:",
      Expires: boundedPositiveInteger(expiresInSeconds, 600, 3600, "COS upload URL TTL"),
      Headers: { "content-type": normalizedType }
    });
    return { url };
  }

  async createSignedDownload({ objectKey, expiresInSeconds, disposition = "attachment" } = {}) {
    const url = await this.signedUrl({
      ...this.objectParams(objectKey),
      Sign: true,
      Method: "GET",
      Protocol: "https:",
      Expires: boundedPositiveInteger(expiresInSeconds, 600, 3600, "COS download URL TTL"),
      Query: { "response-content-disposition": safeDisposition(disposition) }
    });
    return { url };
  }

  async headPrivate({ objectKey } = {}) {
    const params = this.objectParams(objectKey);
    const head = await cosOperation("headObject", () => this.cos.headObject(params));
    const contentType = headerValue(head?.headers, "content-type");
    const byteSize = Number(headerValue(head?.headers, "content-length"));
    if (!contentType || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
      throw new TencentCosPrivateObjectError("headObject", { code: "invalid_object_metadata" });
    }
    if (byteSize > this.config.maxVerifiedObjectBytes) {
      throw new TencentCosPrivateObjectError("headObject", { code: "verified_object_too_large" });
    }

    const hash = crypto.createHash("sha256");
    let downloadedBytes = 0;
    const maximumVerifiedBytes = this.config.maxVerifiedObjectBytes;
    const output = new Writable({
      write(chunk, encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        downloadedBytes += buffer.length;
        if (downloadedBytes > maximumVerifiedBytes) {
          callback(new Error("COS object exceeded the configured verification byte limit"));
          return;
        }
        hash.update(buffer);
        callback();
      }
    });
    await cosOperation("getObject", () => this.cos.getObject({ ...params, Output: output }));
    if (downloadedBytes !== byteSize) {
      throw new TencentCosPrivateObjectError("getObject", { code: "object_length_changed" });
    }
    return { objectKey, contentType, byteSize, sha256: hash.digest("hex") };
  }

  async putPrivate({ objectKey, body, contentType } = {}) {
    const params = this.objectParams(objectKey);
    const source = asNodeReadable(body);
    const digest = digestingTransform(this.config.maxArchiveObjectBytes);
    const upload = cosOperation("putObject", () => this.cos.putObject({
      ...params,
      Body: digest.stream,
      ContentType: requiredString(contentType, "COS object content type")
    }));
    await Promise.all([pipeline(source, digest.stream), upload]);
    return { objectKey, contentType, ...digest.result() };
  }
}

function createTencentCosPrivateObjectDriver({ environment = process.env, cosClient, CosClass } = {}) {
  const config = loadTencentCosConfig(environment);
  return new TencentCosPrivateObjectDriver({ config, cosClient, CosClass });
}

module.exports = {
  DEFAULT_MAX_ARCHIVE_OBJECT_BYTES,
  DEFAULT_MAX_VERIFIED_OBJECT_BYTES,
  TencentCosPrivateObjectDriver,
  TencentCosPrivateObjectError,
  createTencentCosPrivateObjectDriver,
  loadTencentCosConfig
};
