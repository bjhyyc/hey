import { afterEach, describe, expect, it, vi } from "vitest";
import { readStudioGatewayConfiguration, serverStudioRequest } from "@/lib/server-boundary";

describe("server studio boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires HTTPS outside a loopback development origin", () => {
    expect(readStudioGatewayConfiguration({ PETPACK_STUDIO_API_ORIGIN: "http://api.example.com", PETPACK_STUDIO_INTERNAL_TOKEN: "secret", NODE_ENV: "production" })).toEqual({ configured: false, reason: "服务端工作流地址无效" });
    expect(readStudioGatewayConfiguration({ PETPACK_STUDIO_API_ORIGIN: "https://api.example.com", PETPACK_STUDIO_INTERNAL_TOKEN: "secret", NODE_ENV: "production" }).configured).toBe(true);
  });

  it("forwards the opaque session cookie and returns upstream Set-Cookie", async () => {
    vi.stubEnv("PETPACK_STUDIO_API_ORIGIN", "https://api.example.com/");
    vi.stubEnv("PETPACK_STUDIO_INTERNAL_TOKEN", "internal-secret");
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get("cookie")).toBe("petpack_session=opaque");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer internal-secret");
      return new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "petpack_session=new; HttpOnly; Secure; SameSite=Lax; Path=/" },
      });
    }));
    const response = await serverStudioRequest("auth/session", new Request("https://www.heyirmy.com/api/studio/auth/session", { headers: { cookie: "petpack_session=opaque" } }));
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
});
