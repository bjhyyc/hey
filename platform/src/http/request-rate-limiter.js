/**
 * Application-layer request throttling for the Studio API. This is the second
 * of three abuse layers (edge rate limiting / this / account disposal): it
 * cannot absorb a volumetric DDoS - that is the edge's job - but it caps what
 * any single client can make the application and its paid providers do.
 *
 * Fixed one-minute windows per client IP, counted in memory per process. Two
 * buckets: a generous default for the whole API, and a strict one for the
 * routes that are expensive or abusable before payment (login exchange, photo
 * precheck - a free vision-model call - and checkout). Health probes and the
 * Kaipay callback are exempt: throttling the payment provider's notifications
 * would risk payment convergence for no abuse-protection gain.
 */

const net = require("node:net");

const WINDOW_MS = 60_000;
const SWEEP_THRESHOLD = 10_000;
// Every distinct client costs two Map entries for a minute. Past this many the
// limiter stops opening buckets and puts newcomers into one shared bucket
// until a window expires: a flood of made-up addresses can then cost at most
// a bounded amount of memory, never the process.
const MAX_TRACKED_CLIENTS = 50_000;

const EXEMPT_PATH_PREFIXES = Object.freeze(["/livez", "/readyz", "/healthz", "/api/payments/"]);
const SENSITIVE_POST_PREFIXES = Object.freeze(["/api/auth/", "/api/photo-precheck", "/api/checkout"]);

function boundedRate(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function safeIpToken(value) {
  if (typeof value !== "string") return null;
  const first = value.split(",")[0].trim();
  // A bucket key has to be an address. Accepting any short hex-ish string
  // meant `abc`, `::`, `1.2` each opened their own bucket.
  return first && first.length <= 64 && net.isIP(first) !== 0 ? first : null;
}

/**
 * The router percent-decodes every path segment before matching, so the
 * throttle has to look at the same path the router will see: `/api/%63heckout`
 * reaches checkout, and was charged only to the default bucket. A path that
 * cannot be decoded is returned as null and treated as sensitive.
 */
function normalizeRequestPath(raw) {
  const path = typeof raw === "string" ? raw.split("?")[0].split("#")[0] : "";
  try {
    return path.split("/").map((segment) => decodeURIComponent(segment)).join("/");
  } catch (_error) {
    return null;
  }
}

/**
 * Which address is "the client" depends on who is talking:
 *
 * 1. A request that authenticated with the internal gateway bearer comes from
 *    our own Next gateway on CloudBase, and EVERY such request shares one
 *    egress IP - keying on the transport address would put the whole customer
 *    base into a single bucket (the sensitive budget would be 12/min for the
 *    entire site). The gateway attests the real client in
 *    x-petpack-client-ip, and holding the secret token is what makes that
 *    attestation trustworthy.
 * 2. Otherwise, behind our own edge (the production compose network where
 *    Caddy is the only ingress), the first x-forwarded-for entry is the
 *    client; Caddy does not forward untrusted inbound XFF, so it cannot be
 *    spoofed by hitting the edge directly.
 * 3. On loopback, the socket address IS the client.
 */
function resolveClientIp({ socketAddress, forwardedFor, trustForwardedFor, gatewayClientIp = null }) {
  const attested = safeIpToken(gatewayClientIp);
  if (attested) return attested;
  if (trustForwardedFor) {
    const forwarded = safeIpToken(forwardedFor);
    if (forwarded) return forwarded;
  }
  return typeof socketAddress === "string" && socketAddress ? socketAddress : "unknown";
}

function createRequestRateLimiter({
  enabled = true,
  requestsPerMinute = 300,
  sensitiveRequestsPerMinute = 12,
  maxTrackedClients = MAX_TRACKED_CLIENTS,
  now = Date.now,
  logger = console
} = {}) {
  const defaultLimit = boundedRate(requestsPerMinute, 300, 30, 100_000, "requestsPerMinute");
  const sensitiveLimit = boundedRate(sensitiveRequestsPerMinute, 12, 3, 10_000, "sensitiveRequestsPerMinute");
  const trackedCap = boundedRate(maxTrackedClients, MAX_TRACKED_CLIENTS, 4, 10_000_000, "maxTrackedClients");
  if (typeof now !== "function") throw new Error("A clock function is required");
  const windows = new Map();

  function sweep(current, force = false) {
    if (!force && windows.size < SWEEP_THRESHOLD) return;
    for (const [key, entry] of windows) {
      if (current - entry.windowStart >= WINDOW_MS) windows.delete(key);
    }
  }

  function bump(key, limit, current, overflow = false) {
    const entry = windows.get(key);
    if (!entry || current - entry.windowStart >= WINDOW_MS) {
      if (!entry && !overflow && windows.size >= trackedCap) {
        sweep(current, true);
        if (windows.size >= trackedCap) {
          // The `s:`/`d:` prefix keeps the shared bucket in the right tier.
          return bump(`${key.slice(0, 2)}overflow`, limit, current, true);
        }
      }
      windows.set(key, { windowStart: current, count: 1 });
      return { allowed: true };
    }
    entry.count += 1;
    if (entry.count <= limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.windowStart + WINDOW_MS - current) / 1000))
    };
  }

  return {
    enabled: enabled === true,
    check({ method, path, clientIp } = {}) {
      if (enabled !== true) return { allowed: true };
      const decoded = normalizeRequestPath(path);
      const safePath = decoded === null ? "" : decoded;
      if (decoded !== null && EXEMPT_PATH_PREFIXES.some((prefix) => safePath.startsWith(prefix))) return { allowed: true };
      const ip = typeof clientIp === "string" && clientIp ? clientIp : "unknown";
      const current = now();
      sweep(current);
      const sensitive = method === "POST" &&
        (decoded === null || SENSITIVE_POST_PREFIXES.some((prefix) => safePath.startsWith(prefix)));
      if (sensitive) {
        const verdict = bump(`s:${ip}`, sensitiveLimit, current);
        if (!verdict.allowed) {
          logger.warn?.("petpack.http.rate_limited", { bucket: "sensitive", path: safePath.slice(0, 64) });
          return verdict;
        }
      }
      const verdict = bump(`d:${ip}`, defaultLimit, current);
      if (!verdict.allowed) {
        logger.warn?.("petpack.http.rate_limited", { bucket: "default", path: safePath.slice(0, 64) });
      }
      return verdict;
    }
  };
}

module.exports = {
  MAX_TRACKED_CLIENTS,
  createRequestRateLimiter,
  normalizeRequestPath,
  resolveClientIp,
  safeIpToken
};
