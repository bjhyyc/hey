FROM gcr.io/distroless/cc-debian12:nonroot@sha256:adcd20c7b4c988b73cbfbddb26d2eee574571e6d7c9ffea29b3821e0690efb77 AS runtime-base

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

ENV NODE_ENV=production \
    NODE_PATH=/app/platform/node_modules \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

ARG FFMPEG_STATIC_URL=https://github.com/publicala/ffmpeg-static/releases/download/v7.0.2/ffmpeg-7.0.2-amd64-static.tar.xz
ARG FFMPEG_STATIC_FALLBACK_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
ARG FFMPEG_STATIC_SHA256=ABDA8D77CE8309141F83AB8EDF0596834087C52467F6BADF376A6A2A4C87CF67

# The production delivery validator runs the real client inside a pinned
# Electron runtime. The zip checksum below is the published upstream
# SHASUMS256.txt value for electron-v31.7.7-linux-x64.zip and is identical on
# the npmmirror fallback source.
ARG ELECTRON_VERSION=31.7.7
ARG ELECTRON_ZIP_URL=https://github.com/electron/electron/releases/download/v31.7.7/electron-v31.7.7-linux-x64.zip
ARG ELECTRON_ZIP_FALLBACK_URL=https://registry.npmmirror.com/-/binary/electron/31.7.7/electron-v31.7.7-linux-x64.zip
ARG ELECTRON_ZIP_SHA256=00a2e8e5f52fe39c37cfc9d7bd7629e560017d28ee94c51495bf7e39c84b2d47

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true update \
  && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true install -y --no-install-recommends ca-certificates curl unzip xz-utils \
  && mkdir -p /opt/static-ffmpeg \
  && (curl --fail --location --retry 2 --retry-all-errors --retry-delay 2 --retry-max-time 90 --connect-timeout 20 --max-time 90 "$FFMPEG_STATIC_URL" -o /tmp/ffmpeg-static.tar.xz \
      && printf '%s\n' "$FFMPEG_STATIC_URL" > /opt/static-ffmpeg/source-url \
    || (curl --fail --location --retry 2 --retry-all-errors --retry-delay 2 --retry-max-time 90 --connect-timeout 20 --max-time 90 "$FFMPEG_STATIC_FALLBACK_URL" -o /tmp/ffmpeg-static.tar.xz \
      && printf '%s\n' "$FFMPEG_STATIC_FALLBACK_URL" > /opt/static-ffmpeg/source-url)) \
  && printf '%s  %s\n' "$FFMPEG_STATIC_SHA256" /tmp/ffmpeg-static.tar.xz | sha256sum --check --status \
  && tar -xJf /tmp/ffmpeg-static.tar.xz --strip-components=1 -C /opt/static-ffmpeg \
  && test -x /opt/static-ffmpeg/ffmpeg \
  && test -x /opt/static-ffmpeg/ffprobe \
  && install -m 0755 /opt/static-ffmpeg/ffmpeg /usr/bin/ffmpeg \
  && install -m 0755 /opt/static-ffmpeg/ffprobe /usr/bin/ffprobe \
  && ffmpeg -version >/dev/null \
  && ffprobe -version >/dev/null \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/electron \
  && (curl --fail --location --retry 2 --retry-all-errors --retry-delay 2 --retry-max-time 180 --connect-timeout 20 --max-time 600 "$ELECTRON_ZIP_URL" -o /tmp/electron.zip \
      && printf '%s\n' "$ELECTRON_ZIP_URL" > /opt/electron-source-url \
    || (curl --fail --location --retry 2 --retry-all-errors --retry-delay 2 --retry-max-time 180 --connect-timeout 20 --max-time 600 "$ELECTRON_ZIP_FALLBACK_URL" -o /tmp/electron.zip \
      && printf '%s\n' "$ELECTRON_ZIP_FALLBACK_URL" > /opt/electron-source-url)) \
  && printf '%s  %s\n' "$ELECTRON_ZIP_SHA256" /tmp/electron.zip | sha256sum --check --status \
  && unzip -q /tmp/electron.zip -d /opt/electron \
  && rm /tmp/electron.zip \
  && test -x /opt/electron/electron \
  && printf 'source=%s\nversion=%s\nsha256=%s\n' "$(cat /opt/electron-source-url)" "$ELECTRON_VERSION" "$ELECTRON_ZIP_SHA256" > /opt/electron/ELECTRON_RUNTIME_SOURCE.txt

WORKDIR /app/platform

COPY platform/package.json platform/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY platform/src ./src
COPY src/shared /app/src/shared
COPY src/main/services/logger.js /app/src/main/services/logger.js
COPY src/main/services/petpack.js /app/src/main/services/petpack.js
COPY scripts/verify-upstream-petpack-import.js /app/scripts/verify-upstream-petpack-import.js
COPY LICENSE /app/LICENSE

# Pinned clean client tree used by the production delivery validator: the
# isolated upstream importer and the Electron interaction runner both
# re-checksum package.json + package-lock.json + src before every use.
COPY package.json package-lock.json /app/upstream-client/
COPY src /app/upstream-client/src
RUN cd /app/upstream-client \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY platform/docker/media-worker/electron-headless.sh /app/electron-headless
COPY platform/docker/media-worker/write-production-pins.js /opt/write-production-pins.js
RUN chmod 0555 /app/electron-headless \
  && node /opt/write-production-pins.js \
    /app/upstream-client \
    /opt/electron/electron \
    /app/electron-headless \
    /app/platform/src/petpack/run-electron-interaction-verification.js \
    /app/pins

COPY --from=runtime-base / /opt/runtime-base
COPY platform/docker/media-worker/assemble-runtime.sh /usr/local/bin/assemble-media-runtime
RUN chmod 0555 /usr/local/bin/assemble-media-runtime \
  && /usr/local/bin/assemble-media-runtime \
  && mkdir -p /opt/media-root/app/licenses/ffmpeg-runtime \
  && cp /opt/static-ffmpeg/GPLv3.txt /opt/media-root/app/licenses/ffmpeg-runtime/FFMPEG-GPLv3.txt \
  && printf 'source=%s\nupstream=%s\nsha256=%s\nversion=7.0.2-static\n' "$(cat /opt/static-ffmpeg/source-url)" "$FFMPEG_STATIC_FALLBACK_URL" "$FFMPEG_STATIC_SHA256" > /opt/media-root/app/FFMPEG_RUNTIME_SOURCE.txt

# The final stage is node-slim rather than distroless: the production
# delivery validator must execute the pinned Electron runtime under a
# headless X server, which requires a shell, xvfb and the Chromium shared
# library set. The container still runs as 10001 with a read-only root
# filesystem, all capabilities dropped and no-new-privileges.
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

ENV NODE_ENV=production \
    NODE_PATH=/app/platform/node_modules \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    PETPACK_PRODUCTION_UPSTREAM_CLIENT_ROOT=/app/upstream-client \
    PETPACK_PRODUCTION_ELECTRON_PATH=/app/electron-headless \
    PETPACK_PRODUCTION_ELECTRON_RUNNER_PATH=/app/platform/src/petpack/run-electron-interaction-verification.js \
    PETPACK_PRODUCTION_UPSTREAM_CLIENT_TREE_SHA256_FILE=/app/pins/upstream-client-tree.sha256 \
    PETPACK_PRODUCTION_ELECTRON_SHA256_FILE=/app/pins/electron-executable.sha256 \
    PETPACK_PRODUCTION_ELECTRON_RUNNER_SHA256_FILE=/app/pins/electron-runner.sha256 \
    PETPACK_PRODUCTION_ELECTRON_RUNNER_ARGS_FILE=/app/pins/electron-runner-args.json \
    PETPACK_PRODUCTION_ELECTRON_CHILD_ENV_FILE=/app/pins/electron-child-env.json

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true update \
  && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true install -y --no-install-recommends \
    fontconfig \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libegl1 \
    libgbm1 \
    libgl1 \
    libgl1-mesa-dri \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    xauth \
    xvfb \
    xdotool \
  && rm -rf /var/lib/apt/lists/*

# Build tooling is intentionally absent from the production runtime. The
# pinned application dependencies are copied from the build stage, while npm,
# npx, Corepack and Yarn are not used by the Worker. Removing their exact base
# image paths also prevents inherited npm-CLI CVEs from expanding the runtime
# attack surface.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /opt/yarn-v1.22.22 \
  && rm -f \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/corepack

WORKDIR /app/platform

COPY --from=build --chown=10001:10001 /app /app
COPY --from=build /opt/media-root/ /
COPY --from=build /opt/electron /app/electron
COPY --chown=10001:10001 platform/docker/media-worker/work-root /work

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["src/runtime/start-studio-worker.js"]
