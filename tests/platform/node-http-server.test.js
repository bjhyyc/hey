import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createNodeHttpServer } = require("../../platform/src/http/node-http-server");

async function startServer(healthCheck) {
  const server = createNodeHttpServer({
    api: { handle: vi.fn(async () => ({ status: 200, body: { ok: true } })) },
    host: "127.0.0.1",
    port: 0,
    healthCheck,
    logger: { warn: vi.fn() }
  });
  const address = await server.start();
  return { server, origin: `http://${address.host}:${address.port}` };
}

describe("Node HTTP readiness endpoints", () => {
  it("separates liveness from dependency readiness", async () => {
    const healthCheck = vi.fn(async () => ({ ready: true }));
    const { server, origin } = await startServer(healthCheck);
    try {
      await expect(fetch(`${origin}/livez`)).resolves.toMatchObject({ status: 200 });
      const ready = await fetch(`${origin}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ok", database: "ready" });
      const health = await fetch(`${origin}/healthz`);
      expect(health.status).toBe(200);
      expect(healthCheck).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  });

  it("returns 503 without exposing dependency errors", async () => {
    const healthCheck = vi.fn(async () => { throw new Error("secret database detail"); });
    const logger = { warn: vi.fn() };
    const server = createNodeHttpServer({
      api: { handle: vi.fn() },
      host: "127.0.0.1",
      port: 0,
      healthCheck,
      logger
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable", database: "unavailable" });
      expect(logger.warn).toHaveBeenCalledWith("petpack.node_http.readiness_failed", expect.objectContaining({ endpoint: "/readyz" }));
    } finally {
      await server.close();
    }
  });
});
