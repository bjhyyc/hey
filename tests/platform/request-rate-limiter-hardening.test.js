import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createRequestRateLimiter,
  normalizeRequestPath,
  resolveClientIp,
  safeIpToken
} = require("../../platform/src/http/request-rate-limiter");

// Three ways the pre-launch review found to step around the throttle, each
// pinned here in the shape it was found.

function clock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

function limiter(overrides = {}) {
  const time = clock();
  const instance = createRequestRateLimiter({
    requestsPerMinute: 30,
    sensitiveRequestsPerMinute: 3,
    now: time.now,
    logger: { warn() {} },
    ...overrides
  });
  return { instance, time };
}

describe("the sensitive tier is decided on the path the router will see", () => {
  it("charges a percent-encoded checkout path to the sensitive bucket", () => {
    // /api/%63heckout routes to checkout - the router decodes each segment -
    // and used to be counted only against the 300/min default bucket.
    const { instance } = limiter();
    const verdicts = [];
    for (let index = 0; index < 4; index += 1) {
      verdicts.push(instance.check({ method: "POST", path: "/api/%63heckout", clientIp: "203.0.113.5" }).allowed);
    }
    expect(verdicts).toEqual([true, true, true, false]);
  });

  it("treats an undecodable path as sensitive rather than as nothing", () => {
    const { instance } = limiter();
    const verdicts = [];
    for (let index = 0; index < 4; index += 1) {
      verdicts.push(instance.check({ method: "POST", path: "/api/%E0%A4%A", clientIp: "203.0.113.5" }).allowed);
    }
    expect(verdicts).toEqual([true, true, true, false]);
  });

  it("ignores the query string and decodes segments", () => {
    expect(normalizeRequestPath("/api/%63heckout?x=1")).toBe("/api/checkout");
    expect(normalizeRequestPath("/api/photo-precheck#frag")).toBe("/api/photo-precheck");
    expect(normalizeRequestPath("/api/%E0%A4%A")).toBeNull();
  });

  it("still exempts the payment callback once decoded", () => {
    const { instance } = limiter();
    for (let index = 0; index < 50; index += 1) {
      expect(instance.check({ method: "POST", path: "/api/payments/kaipay/notify/x", clientIp: "203.0.113.5" }).allowed).toBe(true);
    }
  });
});

describe("a bucket key has to be an address", () => {
  it("rejects tokens that merely look hex-ish", () => {
    for (const token of ["abc", "1.2", "dead:beef:cafe:zz", "1.2.3.4.5", "203.0.113.9 or 1=1"]) {
      expect(safeIpToken(token), token).toBeNull();
    }
    expect(safeIpToken("203.0.113.9")).toBe("203.0.113.9");
    expect(safeIpToken("2001:db8::9")).toBe("2001:db8::9");
    expect(safeIpToken("203.0.113.9, 10.0.0.1")).toBe("203.0.113.9");
  });

  it("falls back past a non-address attestation instead of keying on it", () => {
    expect(resolveClientIp({
      socketAddress: "10.0.0.2",
      forwardedFor: null,
      trustForwardedFor: false,
      gatewayClientIp: "abc"
    })).toBe("10.0.0.2");
  });
});

describe("the limiter's memory is bounded", () => {
  it("puts clients beyond the cap into one shared bucket until a window expires", () => {
    const { instance, time } = limiter({ maxTrackedClients: 4 });
    // Four distinct clients fill the cap (default-tier entries only).
    for (let index = 1; index <= 4; index += 1) {
      expect(instance.check({ method: "GET", path: "/api/projects", clientIp: `203.0.113.${index}` }).allowed).toBe(true);
    }
    // Every further newcomer shares one sensitive bucket of 3 - so the fourth
    // distinct newcomer is refused even though each is on its first request.
    const verdicts = [];
    for (let index = 10; index < 14; index += 1) {
      verdicts.push(instance.check({ method: "POST", path: "/api/checkout", clientIp: `198.51.100.${index}` }).allowed);
    }
    expect(verdicts).toEqual([true, true, true, false]);
    // Once the window rolls over the sweep frees the map and newcomers get
    // their own buckets again.
    time.advance(60_001);
    expect(instance.check({ method: "POST", path: "/api/checkout", clientIp: "198.51.100.20" }).allowed).toBe(true);
  });
});
