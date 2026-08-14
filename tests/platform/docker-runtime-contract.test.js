import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("production Docker build contracts", () => {
  it("uses an allowlisted root build context that excludes development fixtures", () => {
    const dockerignore = read(".dockerignore");
    expect(dockerignore.trimStart().startsWith("**")).toBe(true);
    for (const required of [
      "!platform/package.json",
      "!platform/package-lock.json",
      "!platform/docker/media-worker/assemble-runtime.sh",
      "!platform/src/**",
      "platform/src/development/**",
      "!src/shared/**",
      "!LICENSE"
    ]) expect(dockerignore).toContain(required);
    expect(dockerignore).not.toContain("!tests");
    expect(dockerignore).not.toContain("!.env");
  });

  it("pins the auth/API runtime to the patched Node image and a non-root user", () => {
    const dockerfile = read("platform/docker/runtime/Dockerfile");
    expect(dockerfile).toContain("node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e");
    expect(dockerfile).toContain("gcr.io/distroless/cc-debian12:nonroot@sha256:adcd20c7b4c988b73cbfbddb26d2eee574571e6d7c9ffea29b3821e0690efb77");
    expect(dockerfile).toContain("COPY platform/package.json platform/package-lock.json ./");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node"]');
    expect(dockerfile).not.toMatch(/COPY\s+\.\s/);
  });

  it("builds the Studio Worker from platform dependencies with pinned Node and FFmpeg", () => {
    const dockerfile = read("platform/docker/media-worker/Dockerfile");
    expect(dockerfile).toContain("node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e");
    expect(dockerfile).toContain("gcr.io/distroless/cc-debian12:nonroot@sha256:adcd20c7b4c988b73cbfbddb26d2eee574571e6d7c9ffea29b3821e0690efb77");
    expect(dockerfile).toContain("install -y --no-install-recommends ffmpeg");
    expect(dockerfile).toContain("Acquire::http::Timeout=30");
    expect(dockerfile).toContain("Acquire::Retries=3");
    expect(dockerfile).toContain("COPY platform/package.json platform/package-lock.json ./");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node"]');
    expect(dockerfile).toContain('CMD ["src/runtime/start-studio-worker.js"]');
    expect(dockerfile).toContain("assemble-media-runtime");
    expect(dockerfile).toContain("COPY --from=build /opt/media-root/ /");
    expect(dockerfile).not.toContain("COPY platform ./platform");
    expect(dockerfile).not.toContain("FROM node:20");
  });
});
