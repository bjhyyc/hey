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

const WINDOW_MS = 60_000;
const SWEEP_THRESHOLD = 10_000;

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

/**
 * The first entry of x-forwarded-for is the client as reported by the edge.
 * Trust it only when explicitly told the deployment sits behind a proxy that
 * is the sole route to this process (the production compose network, where
 * Caddy is the only ingress); otherwise the socket address is the client.
 */
function resolveClientIp({ socketAddress, forwardedFor, trustForwardedFor }) {
  if (trustForwardedFor && typeof forwardedFor === "string" && forwardedFor.trim()) {
    const first = forwardedFor.split(",")[0].trim();
    if (first && first.length <= 64 && /^[0-9a-fA-F.:]+$/.test(first)) return first;
  }
  return typeof socketAddress === "string" && socketAddress ? socketAddress : "unknown";
}

function createRequestRateLimiter({
  enabled = true,
  requestsPerMinute = 300,
  sensitiveRequestsPerMinute = 12,
  now = Date.now,
  logger = console
} = {}) {
  const defaultLimit = boundedRate(requestsPerMinute, 300, 30, 100_000, "requestsPerMinute");
  const sensitiveLimit = boundedRate(sensitiveRequestsPerMinute, 12, 3, 10_000, "sensitiveRequestsPerMinute");
  if (typeof now !== "function") throw new Error("A clock function is required");
  const windows = new Map();

  function sweep(current) {
    if (windows.size < SWEEP_THRESHOLD) return;
    for (const [key, entry] of windows) {
      if (current - entry.windowStart >= WINDOW_MS) windows.delete(key);
    }
  }

  function bump(key, limit, current) {
    const entry = windows.get(key);
    if (!entry || current - entry.windowStart >= WINDOW_MS) {
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
      const safePath = typeof path === "string" ? path : "";
      if (EXEMPT_PATH_PREFIXES.some((prefix) => safePath.startsWith(prefix))) return { allowed: true };
      const ip = typeof clientIp === "string" && clientIp ? clientIp : "unknown";
      const current = now();
      sweep(current);
      const sensitive = method === "POST" && SENSITIVE_POST_PREFIXES.some((prefix) => safePath.startsWith(prefix));
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
  createRequestRateLimiter,
  resolveClientIp
};
