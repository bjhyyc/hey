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
      "!platform/docker/media-worker/electron-headless.sh",
      "!platform/docker/media-worker/write-production-pins.js",
      "!platform/src/**",
      "platform/src/development/**",
      "!src/shared/**",
      "!package.json",
      "!package-lock.json",
      "!scripts/verify-upstream-petpack-import.js",
      "!LICENSE"
    ]) expect(dockerignore).toContain(required);
    expect(dockerignore).not.toContain("!tests");
    expect(dockerignore).not.toContain("!.env");
    // The wider scripts directory stays excluded; only the single reviewed
    // upstream-import child is allowed into the build context.
    expect(dockerignore).toContain("scripts/**");
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
    expect(dockerfile).toContain("FFMPEG_STATIC_URL=https://github.com/publicala/ffmpeg-static/releases/download/v7.0.2/ffmpeg-7.0.2-amd64-static.tar.xz");
    expect(dockerfile).toContain("FFMPEG_STATIC_FALLBACK_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz");
    expect(dockerfile).toContain("FFMPEG_STATIC_SHA256=ABDA8D77CE8309141F83AB8EDF0596834087C52467F6BADF376A6A2A4C87CF67");
    expect(dockerfile).toContain("sha256sum --check --status");
    expect(dockerfile).not.toContain("install -y --no-install-recommends ffmpeg");
    expect(dockerfile).toContain("Acquire::http::Timeout=30");
    expect(dockerfile).toContain("Acquire::Retries=3");
    expect(dockerfile).toContain("--retry-all-errors");
    expect(dockerfile).toContain("--connect-timeout 20");
    expect(dockerfile).toContain("COPY platform/package.json platform/package-lock.json ./");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node"]');
    expect(dockerfile).toContain('CMD ["src/runtime/start-studio-worker.js"]');
    expect(dockerfile).toContain("assemble-media-runtime");
    expect(dockerfile).toContain("FFMPEG_RUNTIME_SOURCE.txt");
    expect(dockerfile).toContain("COPY --from=build /opt/media-root/ /");
    expect(dockerfile).not.toContain("COPY platform ./platform");
    expect(dockerfile).not.toContain("FROM node:20");
  });

  it("pins the production delivery-validation layer inside the Worker image", () => {
    const dockerfile = read("platform/docker/media-worker/Dockerfile");
    expect(dockerfile).toContain("ELECTRON_ZIP_URL=https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-linux-x64.zip");
    expect(dockerfile).toContain("ELECTRON_ZIP_FALLBACK_URL=https://registry.npmmirror.com/-/binary/electron/31.7.7/electron-v31.7.7-linux-x64.zip");
    expect(dockerfile).toContain("ELECTRON_ZIP_SHA256=00a2e8e5f52fe39c37cfc9d7bd7629e560017d28ee94c51495bf7e39c84b2d47");
    expect(dockerfile).toContain("COPY package.json package-lock.json /app/upstream-client/");
    expect(dockerfile).toContain("COPY src /app/upstream-client/src");
    expect(dockerfile).toContain("COPY scripts/verify-upstream-petpack-import.js /app/scripts/verify-upstream-petpack-import.js");
    expect(dockerfile).toContain("COPY platform/docker/media-worker/electron-headless.sh /app/electron-headless");
    expect(dockerfile).toContain("write-production-pins.js");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_UPSTREAM_CLIENT_ROOT=/app/upstream-client");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_ELECTRON_PATH=/app/electron-headless");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_ELECTRON_RUNNER_PATH=/app/platform/src/petpack/run-electron-interaction-verification.js");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_UPSTREAM_CLIENT_TREE_SHA256_FILE=/app/pins/upstream-client-tree.sha256");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_ELECTRON_SHA256_FILE=/app/pins/electron-executable.sha256");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_ELECTRON_RUNNER_SHA256_FILE=/app/pins/electron-runner.sha256");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_ELECTRON_RUNNER_ARGS_FILE=/app/pins/electron-runner-args.json");
    expect(dockerfile).toContain("PETPACK_PRODUCTION_ELECTRON_CHILD_ENV_FILE=/app/pins/electron-child-env.json");
    expect(dockerfile).toContain("xvfb");
    expect(dockerfile).toContain("xauth");
    expect(dockerfile).toContain("libgtk-3-0");
    expect(dockerfile).toContain("libnss3");
    // Electron runs only through the reviewed wrapper; the image never grants
    // the Chromium SUID sandbox helper elevated privileges.
    expect(dockerfile).not.toContain("chrome-sandbox");
    expect(dockerfile).not.toContain("setuid");
  });
});
