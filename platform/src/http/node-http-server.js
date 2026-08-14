const http = require("node:http");

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

class NodeHttpBoundaryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "NodeHttpBoundaryError";
    this.status = status;
    this.code = code;
  }
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function requireApi(api) {
  if (!api || typeof api.handle !== "function") throw new Error("A PetPack HTTP API is required");
  return api;
}

function safeHeaders(headers = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ");
  }
  return result;
}

async function readBoundedBody(request, maxBodyBytes) {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new NodeHttpBoundaryError(400, "invalid_request", "请求内容无效");
    if (parsed > maxBodyBytes) throw new NodeHttpBoundaryError(413, "request_too_large", "请求内容过大");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw new NodeHttpBoundaryError(413, "request_too_large", "请求内容过大");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks, bytes) : Buffer.alloc(0);
}

function writeResponse(response, result) {
  const status = Number.isSafeInteger(result?.status) ? result.status : 500;
  const headers = safeHeaders(result?.headers);
  const noContent = status === 204;
  if (noContent) delete headers["content-type"];
  const contentType = noContent ? "" : (headers["content-type"] || "application/json; charset=utf-8");
  const body = noContent
    ? ""
    : contentType.toLowerCase().startsWith("application/json")
      ? JSON.stringify(result?.body === undefined ? {} : result.body)
      : String(result?.body === undefined ? "" : result.body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
    "content-length": Buffer.byteLength(body, "utf8")
  });
  response.end(body);
}

function safeFailure(error) {
  if (error instanceof NodeHttpBoundaryError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  return { status: 500, body: { error: { code: "internal_error", message: "服务暂时不可用，请稍后重试" } } };
}

function createNodeHttpServer({
  api,
  host = "127.0.0.1",
  port = 8787,
  allowNonLoopback = false,
  healthCheck = async () => ({ ready: true }),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  logger = console
} = {}) {
  const httpApi = requireApi(api);
  if (host !== "127.0.0.1" && !(allowNonLoopback === true && host === "0.0.0.0")) {
    throw new Error("The PetPack API must bind to 127.0.0.1 unless the production container explicitly enables 0.0.0.0 on its internal network");
  }
  const listenPort = boundedInteger(port, 8787, 0, 65_535, "Local API port");
  const bodyLimit = boundedInteger(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1_024, 2 * 1024 * 1024, "Local API body limit");
  const timeoutMs = boundedInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 60_000, "Local API request timeout");
  if (typeof healthCheck !== "function") throw new Error("A health check is required");

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        const health = await healthCheck();
        writeResponse(response, { status: 200, body: { status: "ok", database: health?.ready === true ? "ready" : "unavailable" } });
        return;
      }
      const rawBody = await readBoundedBody(request, bodyLimit);
      const result = await httpApi.handle({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: rawBody.length ? rawBody : undefined,
        rawBody: rawBody.length ? rawBody : undefined
      });
      writeResponse(response, result);
    } catch (error) {
      logger.warn?.("petpack.node_http.request_failed", {
        errorName: error && error.name ? error.name : "Error",
        status: error instanceof NodeHttpBoundaryError ? error.status : 500
      });
      if (!response.headersSent) writeResponse(response, safeFailure(error));
      else response.destroy();
    }
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(60_000, timeoutMs + 5_000);
  server.keepAliveTimeout = 5_000;

  let started = false;
  return {
    async start() {
      if (started) throw new Error("Local PetPack API is already running");
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(listenPort, host);
      });
      started = true;
      const address = server.address();
      return Object.freeze({ host, port: typeof address === "object" && address ? address.port : listenPort });
    },
    async close() {
      if (!started) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      started = false;
    }
  };
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  NodeHttpBoundaryError,
  createNodeHttpServer,
  readBoundedBody
};
