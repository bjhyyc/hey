import { describe, expect, it } from "vitest";
import {
  browserStudioUrl,
  normalizeStudioPath,
  platformStudioPath,
  StudioGatewayError,
} from "@/lib/studio-gateway-core";

describe("studio gateway path boundary", () => {
  it("builds same-origin browser routes", () => {
    expect(browserStudioUrl(["projects", "project-123", "progress"])).toBe(
      "/api/studio/projects/project-123/progress",
    );
  });

  it.each([
    ["auth/session", "/api/auth/session"],
    ["api", "/api"],
    ["/api/auth/session", "/api/auth/session"],
    [["api", "projects", "project-123"], "/api/projects/project-123"],
  ])("builds one canonical platform API prefix for %j", (path, expected) => {
    expect(platformStudioPath(path)).toBe(expected);
  });

  it.each(["", "../admin", "projects/%2e%2e/admin", "https://example.com", "projects\\admin"])(
    "rejects unsafe path %s",
    (path) => {
      expect(() => normalizeStudioPath(path)).toThrow(StudioGatewayError);
    },
  );

  it("rejects malformed percent encoding without throwing an implementation error", () => {
    expect(() => normalizeStudioPath("projects/%zz")).toThrow(StudioGatewayError);
  });
});
