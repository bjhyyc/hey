import { describe, expect, it, vi } from "vitest";

import adminOrdersModule from "../../platform/src/api/admin-orders-service.js";
import httpApiModule from "../../platform/src/http/petpack-studio-http-api.js";
import rateLimiterModule from "../../platform/src/http/request-rate-limiter.js";
import nodeHttpModule from "../../platform/src/http/node-http-server.js";

// P3 of the support console. Refunds are the last resort and ship dark: the
// endpoint exists but refuses until the deployment flips the acceptance flag,
// honoring the controlled real-refund gate in BLOCKED.md. Account disposal is
// the answer to quota abuse, not to volumetric DDoS - that split, and the
// per-IP throttle that sits between them, is deliberate.

const { AdminOrdersService } = adminOrdersModule;
const { createPetPackStudioHttpApi } = httpApiModule;
const { createRequestRateLimiter, resolveClientIp } = rateLimiterModule;
const { createNodeHttpServer } = nodeHttpModule;

const admin = Object.freeze({ id: "admin-1", role: "admin" });

const paidContext = (status = "paid") => ({
  order: { id: "order-1", userId: "user-7", amountFen: 4900, status },
  project: { id: "project-1", displayName: "豆豆", state: "producing" },
  run: null,
  failedFromState: null,
  adminRerunCount: 0,
  masterAttempts: [],
  actions: [],
  rejectedActionVideos: [],
  delivery: null,
  dispatch: { pending: 0, leased: 0, failed: 0, dead: 0 },
  timeline: []
});

function createService({ context = paidContext(), refundEnabled = true, providerOverrides = {} } = {}) {
  const audits = [];
  const repository = {
    findAdminOperations: vi.fn(async () => []),
    getAdminOrderRescueContext: vi.fn(async () => context),
    recordAdminAuditEvent: vi.fn(async (event) => { audits.push(event); return { recorded: true }; }),
    extendDeliveryWindow: vi.fn(),
    createAdminRefund: vi.fn(async () => ({ refundId: "refund-row-1", amountFen: 4900, status: "requested", alreadyRequested: false })),
    applyAdminRefundRequested: vi.fn(async () => ({ orderStatus: "refund_pending", refundStatus: "processing", runsStopped: 1 })),
    completeAdminRefund: vi.fn(async () => ({ orderStatus: "refunded" })),
    getAdminUserView: vi.fn(async () => ({
      id: "user-7", role: "user", status: "active", createdAt: "2026-08-01T00:00:00.000Z",
      orderCount: 2, activeSessions: 1, prechecks24h: 3, recentOrders: []
    })),
    setAdminUserStatus: vi.fn(async ({ userId, status }) => ({ id: userId, status, revokedSessions: status === "disabled" ? 2 : 0 }))
  };
  const workflow = {
    adminRerunCharacterMaster: vi.fn(), adminRerunSleepMaster: vi.fn(), adminRerunVideoAction: vi.fn(),
    adminGrantCharacterRegeneration: vi.fn(),
    adminOverrideCharacterMaster: vi.fn(), adminOverrideSleepMaster: vi.fn(), adminOverrideVideoAction: vi.fn()
  };
  const paymentProvider = {
    refund: vi.fn(async () => ({ state: "refund_pending", providerRefundId: "kaipay-rf-1" })),
    queryStatus: vi.fn(async () => ({ state: "refund_pending", paymentEventKey: "event-key-1" })),
    ...providerOverrides
  };
  const objectStore = { createDownloadGrant: vi.fn(async () => ({ url: "https://signed.example/x" })) };
  const service = new AdminOrdersService({
    repository, workflow, objectStore, paymentProvider, refundEnabled,
    logger: { info() {}, warn() {}, error() {} }
  });
  return { service, repository, paymentProvider, audits };
}

describe("AdminOrdersService.refundOrder", () => {
  it("ships dark: refuses until the acceptance flag enables refunds", async () => {
    const { service } = createService({ refundEnabled: false });
    try {
      await service.refundOrder({ actor: admin, orderId: "order-1", reason: "r" });
      throw new Error("expected the disabled refusal");
    } catch (error) {
      expect(error.code).toBe("admin_refund_disabled");
    }
  });

  it("initiates a full refund with a stable request number and stamps the audit trail", async () => {
    const { service, repository, paymentProvider, audits } = createService();
    const outcome = await service.refundOrder({ actor: admin, orderId: "order-1", reason: "生成三次失败，客户要求退款" });
    expect(outcome.mode).toBe("refund_requested");
    expect(outcome.order.status).toBe("refund_pending");
    // The staged refund row's ID doubles as the provider refundRequestNo, so a
    // retried call repeats the same request instead of minting a second refund.
    expect(paymentProvider.refund).toHaveBeenCalledWith(expect.objectContaining({
      refundId: "refund-row-1",
      amountFen: 4900,
      idempotencyKey: "admin-refund:order-1"
    }));
    expect(repository.applyAdminRefundRequested).toHaveBeenCalledWith(expect.objectContaining({
      providerRefundId: "kaipay-rf-1"
    }));
    expect(audits[0].eventType).toBe("admin_refund_requested");
  });

  it("requires a reason to initiate but not to poll", async () => {
    const { service, paymentProvider } = createService();
    await expect(service.refundOrder({ actor: admin, orderId: "order-1" })).rejects.toThrowError(/reason is required/i);
    expect(paymentProvider.refund).not.toHaveBeenCalled();
  });

  it("polls a pending refund and converges only on the provider's refunded verdict", async () => {
    const pending = createService({ context: paidContext("refund_pending") });
    const still = await pending.service.refundOrder({ actor: admin, orderId: "order-1" });
    expect(still.mode).toBe("refund_pending");
    expect(pending.repository.completeAdminRefund).not.toHaveBeenCalled();

    const done = createService({
      context: paidContext("refund_pending"),
      providerOverrides: { queryStatus: vi.fn(async () => ({ state: "refunded", paymentEventKey: "event-key-2" })) }
    });
    const confirmed = await done.service.refundOrder({ actor: admin, orderId: "order-1" });
    expect(confirmed.mode).toBe("refund_confirmed");
    expect(done.repository.completeAdminRefund).toHaveBeenCalledWith(expect.objectContaining({ paymentEventKey: "event-key-2" }));
    expect(done.audits[0].eventType).toBe("admin_refund_confirmed");
  });

  it("refuses any other order status and reports an already refunded order plainly", async () => {
    const unpaid = createService({ context: paidContext("pending_payment") });
    try {
      await unpaid.service.refundOrder({ actor: admin, orderId: "order-1", reason: "r" });
      throw new Error("expected the status refusal");
    } catch (error) {
      expect(error.code).toBe("admin_refund_unavailable");
    }
    const refunded = createService({ context: paidContext("refunded") });
    const outcome = await refunded.service.refundOrder({ actor: admin, orderId: "order-1" });
    expect(outcome.mode).toBe("refund_already_complete");
  });
});

describe("AdminOrdersService user disposal", () => {
  it("returns the account view to administrators only", async () => {
    const { service } = createService();
    const view = await service.getUserView({ actor: admin, userId: "user-7" });
    expect(view.orderCount).toBe(2);
    await expect(service.getUserView({ actor: { id: "user-1", role: "user" }, userId: "user-7" }))
      .rejects.toThrowError(/Administrator role/);
  });

  it("disables an account with a reason and reports the revoked sessions", async () => {
    const { service, repository } = createService();
    const outcome = await service.setUserStatus({ actor: admin, userId: "user-7", status: "disabled", reason: "预检配额刷爆" });
    expect(outcome.user.status).toBe("disabled");
    expect(outcome.revokedSessions).toBe(2);
    expect(repository.setAdminUserStatus).toHaveBeenCalledWith(expect.objectContaining({ reason: "预检配额刷爆" }));
  });

  it("refuses self-disposal", async () => {
    const { service } = createService();
    try {
      await service.setUserStatus({ actor: admin, userId: "admin-1", status: "disabled", reason: "r" });
      throw new Error("expected the self-disposal refusal");
    } catch (error) {
      expect(error.code).toBe("admin_user_disposal_unavailable");
    }
  });
});

describe("admin refund and user HTTP surface", () => {
  const orderId = "3f2b8c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f";
  const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function createApi(adminOrdersService) {
    return createPetPackStudioHttpApi({
      adminOrdersService,
      resolveActor: async () => admin,
      logger: { info() {}, warn() {}, error() {} }
    });
  }

  it("routes refund with an optional reason, and user view and disposal", async () => {
    const adminOrdersService = {
      searchOrders: vi.fn(), getOrderDetail: vi.fn(), rerunStage: vi.fn(), qaOverrideStage: vi.fn(), reissueDelivery: vi.fn(),
      refundOrder: vi.fn(async () => ({ mode: "refund_pending", order: { id: "order-1", status: "refund_pending" }, providerState: "refund_pending" })),
      getUserView: vi.fn(async () => ({ id: userId, role: "user", status: "active", createdAt: null, orderCount: 1, activeSessions: 0, prechecks24h: 0, recentOrders: [] })),
      setUserStatus: vi.fn(async () => ({ user: { id: userId, status: "disabled" }, revokedSessions: 3 }))
    };
    const api = createApi(adminOrdersService);

    const poll = await api.handle({
      method: "POST", path: `/api/admin/orders/${orderId}/refund`, headers: {}, body: JSON.stringify({})
    });
    expect(poll.status).toBe(200);
    expect(poll.body.mode).toBe("refund_pending");
    expect(adminOrdersService.refundOrder).toHaveBeenCalledWith(expect.not.objectContaining({ reason: expect.anything() }));

    const view = await api.handle({ method: "GET", path: `/api/admin/users/${userId}`, headers: {} });
    expect(view.status).toBe(200);
    expect(view.body.orderCount).toBe(1);

    const disable = await api.handle({
      method: "POST", path: `/api/admin/users/${userId}/disable`, headers: {}, body: JSON.stringify({ reason: "刷接口" })
    });
    expect(disable.status).toBe(200);
    expect(disable.body.revokedSessions).toBe(3);
    expect(adminOrdersService.setUserStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "disabled" }));
  });

  it("maps the dark-launch refusal to 503 and disposal refusals to 409", async () => {
    const darkError = new Error("refunds disabled");
    darkError.code = "admin_refund_disabled";
    const adminOrdersService = {
      searchOrders: vi.fn(), getOrderDetail: vi.fn(), rerunStage: vi.fn(), qaOverrideStage: vi.fn(), reissueDelivery: vi.fn(),
      refundOrder: vi.fn(async () => { throw darkError; }),
      getUserView: vi.fn(),
      setUserStatus: vi.fn()
    };
    const api = createApi(adminOrdersService);
    const response = await api.handle({
      method: "POST", path: `/api/admin/orders/${orderId}/refund`, headers: {}, body: JSON.stringify({ reason: "r" })
    });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("admin_refund_disabled");
  });
});

describe("request rate limiter", () => {
  it("caps a single client inside a fixed window and names the wait", () => {
    let clock = 1_000_000;
    const limiter = createRequestRateLimiter({
      requestsPerMinute: 30, sensitiveRequestsPerMinute: 3,
      now: () => clock, logger: { warn() {} }
    });
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.check({ method: "GET", path: "/api/projects", clientIp: "1.2.3.4" }).allowed).toBe(true);
    }
    const blocked = limiter.check({ method: "GET", path: "/api/projects", clientIp: "1.2.3.4" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // Another client is unaffected; the same client recovers after the window.
    expect(limiter.check({ method: "GET", path: "/api/projects", clientIp: "5.6.7.8" }).allowed).toBe(true);
    clock += 60_001;
    expect(limiter.check({ method: "GET", path: "/api/projects", clientIp: "1.2.3.4" }).allowed).toBe(true);
  });

  it("throttles the pre-payment abuse surface far tighter than the rest", () => {
    let clock = 1_000_000;
    const limiter = createRequestRateLimiter({
      requestsPerMinute: 1000, sensitiveRequestsPerMinute: 3,
      now: () => clock, logger: { warn() {} }
    });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check({ method: "POST", path: "/api/photo-precheck", clientIp: "1.2.3.4" }).allowed).toBe(true);
    }
    expect(limiter.check({ method: "POST", path: "/api/photo-precheck", clientIp: "1.2.3.4" }).allowed).toBe(false);
    // GET traffic on the same path shape is not in the sensitive bucket.
    expect(limiter.check({ method: "GET", path: "/api/projects", clientIp: "1.2.3.4" }).allowed).toBe(true);
  });

  it("never throttles health probes or the payment callback", () => {
    const limiter = createRequestRateLimiter({
      requestsPerMinute: 30, sensitiveRequestsPerMinute: 3,
      now: () => 1_000_000, logger: { warn() {} }
    });
    for (let i = 0; i < 200; i += 1) {
      expect(limiter.check({ method: "GET", path: "/readyz", clientIp: "1.2.3.4" }).allowed).toBe(true);
      expect(limiter.check({ method: "POST", path: "/api/payments/kaipay/notify/order-1", clientIp: "1.2.3.4" }).allowed).toBe(true);
    }
  });

  it("trusts x-forwarded-for only when told the proxy is the sole ingress", () => {
    expect(resolveClientIp({ socketAddress: "172.18.0.2", forwardedFor: "203.0.113.9, 172.18.0.1", trustForwardedFor: true }))
      .toBe("203.0.113.9");
    expect(resolveClientIp({ socketAddress: "127.0.0.1", forwardedFor: "203.0.113.9", trustForwardedFor: false }))
      .toBe("127.0.0.1");
    expect(resolveClientIp({ socketAddress: "172.18.0.2", forwardedFor: "<script>", trustForwardedFor: true }))
      .toBe("172.18.0.2");
  });

  it("prefers the gateway-attested customer address over every transport hint", () => {
    // All relayed traffic shares one CloudBase egress IP; the attested header
    // is what keeps per-client throttling per-client.
    expect(resolveClientIp({
      socketAddress: "172.18.0.2",
      forwardedFor: "43.143.111.226",
      trustForwardedFor: true,
      gatewayClientIp: "203.0.113.77"
    })).toBe("203.0.113.77");
    // A malformed attestation falls back instead of poisoning the key.
    expect(resolveClientIp({
      socketAddress: "172.18.0.2",
      forwardedFor: "43.143.111.226",
      trustForwardedFor: true,
      gatewayClientIp: "not an ip"
    })).toBe("43.143.111.226");
  });

  it("honors the attested address only when the caller holds the gateway bearer", async () => {
    const token = "t".repeat(48);
    const seen = [];
    const api = { handle: vi.fn(async () => ({ status: 200, body: { ok: true } })) };
    const limiter = {
      check(input) { seen.push(input.clientIp); return { allowed: true }; }
    };
    const server = createNodeHttpServer({
      api, port: 0, rateLimiter: limiter, internalBearerToken: token,
      logger: { warn() {}, info() {} }
    });
    const address = await server.start();
    try {
      await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
        headers: { authorization: `Bearer ${token}`, "x-petpack-client-ip": "203.0.113.88" }
      });
      await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
        headers: { authorization: "Bearer wrong-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "x-petpack-client-ip": "203.0.113.99" }
      });
      expect(seen[0]).toBe("203.0.113.88");
      expect(seen[1]).not.toBe("203.0.113.99");
    } finally {
      await server.close();
    }
  });

  it("returns 429 with retry-after through the HTTP server", async () => {
    const api = { handle: vi.fn(async () => ({ status: 200, body: { ok: true } })) };
    const limiter = createRequestRateLimiter({
      requestsPerMinute: 30, sensitiveRequestsPerMinute: 3, logger: { warn() {} }
    });
    const server = createNodeHttpServer({ api, port: 0, rateLimiter: limiter, logger: { warn() {}, info() {} } });
    const address = await server.start();
    try {
      let lastStatus = 0;
      let retryAfter = null;
      for (let i = 0; i < 32; i += 1) {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`);
        lastStatus = response.status;
        if (response.status === 429) {
          retryAfter = response.headers.get("retry-after");
          break;
        }
      }
      expect(lastStatus).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
      const health = await fetch(`http://127.0.0.1:${address.port}/livez`);
      expect(health.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
