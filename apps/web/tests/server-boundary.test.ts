import { afterEach, describe, expect, it, vi } from "vitest";
import { readStudioGatewayConfiguration, serverStudioRequest } from "@/lib/server-boundary";

describe("server studio boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires HTTPS outside a loopback development origin", () => {
    expect(readStudioGatewayConfiguration({ PETPACK_STUDIO_API_ORIGIN: "http://api.example.com", PETPACK_STUDIO_INTERNAL_TOKEN: "secret", NODE_ENV: "production" })).toEqual({ configured: false, reason: "服务端工作流地址无效" });
    expect(readStudioGatewayConfiguration({ PETPACK_STUDIO_API_ORIGIN: "https://api.example.com", PETPACK_STUDIO_INTERNAL_TOKEN: "secret", NODE_ENV: "production" }).configured).toBe(true);
  });

  it.each([
    "https://api.example.com/api",
    "https://api.example.com/platform/",
    "https://api.example.com/?tenant=one",
    "https://user:password@api.example.com/",
  ])("rejects a non-origin API configuration: %s", (origin) => {
    expect(readStudioGatewayConfiguration({
      PETPACK_STUDIO_API_ORIGIN: origin,
      PETPACK_STUDIO_INTERNAL_TOKEN: "secret",
      NODE_ENV: "production",
    })).toEqual({ configured: false, reason: "服务端工作流地址无效" });
  });

  it.each([
    ["auth/session", "https://api.example.com/api/auth/session"],
    ["api/auth/session", "https://api.example.com/api/auth/session"],
  ])("forwards %s to the canonical platform API URL", async (path, expectedTarget) => {
    vi.stubEnv("PETPACK_STUDIO_API_ORIGIN", "https://api.example.com/");
    vi.stubEnv("PETPACK_STUDIO_INTERNAL_TOKEN", "internal-secret");
    vi.stubGlobal("fetch", vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).toBe(expectedTarget);
      expect(new Headers(init.headers).get("cookie")).toBe("petpack_session=opaque");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer internal-secret");
      return new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "petpack_session=new; HttpOnly; Secure; SameSite=Lax; Path=/" },
      });
    }));
    const response = await serverStudioRequest(path, new Request("https://www.heyirmy.com/api/studio/auth/session", { headers: { cookie: "petpack_session=opaque" } }));
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
});
