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

  it("attests the address the ingress appended, never one the browser supplied", async () => {
    // Verified against the live ingress: CloudBase passes a browser's own
    // X-Real-IP and X-Forwarded-For through and appends the true peer at the
    // end of X-Forwarded-For. Rotating the front entries per request used to
    // give every request its own throttle bucket.
    vi.stubEnv("PETPACK_STUDIO_API_ORIGIN", "https://api.example.com/");
    vi.stubEnv("PETPACK_STUDIO_INTERNAL_TOKEN", "internal-secret");
    const attested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, init: RequestInit) => {
      attested.push(new Headers(init.headers).get("x-petpack-client-ip") ?? "(none)");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }));
    const call = (headers: Record<string, string>) =>
      serverStudioRequest("projects", new Request("https://www.heyirmy.com/api/studio/projects", { headers }));
    await call({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
    await call({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" });
    await call({ "x-forwarded-for": "2001:db8::1, 2001:db8::9" });
    await call({ "x-forwarded-for": "abc" });
    await call({ "x-real-ip": "198.51.100.7" });
    expect(attested).toEqual(["203.0.113.9", "203.0.113.9", "2001:db8::9", "(none)", "(none)"]);
  });
});
