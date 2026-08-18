FROM gcr.io/distroless/cc-debian12:nonroot@sha256:adcd20c7b4c988b73cbfbddb26d2eee574571e6d7c9ffea29b3821e0690efb77 AS runtime-base

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

ENV NODE_ENV=production \
    NODE_PATH=/app/platform/node_modules \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

ARG FFMPEG_STATIC_URL=https://github.com/publicala/ffmpeg-static/releases/download/v7.0.2/ffmpeg-7.0.2-amd64-static.tar.xz
ARG FFMPEG_STATIC_FALLBACK_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
ARG FFMPEG_STATIC_SHA256=ABDA8D77CE8309141F83AB8EDF0596834087C52467F6BADF376A6A2A4C87CF67

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true update \
  && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true install -y --no-install-recommends ca-certificates curl xz-utils \
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

WORKDIR /app/platform

COPY platform/package.json platform/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY platform/src ./src
COPY src/shared /app/src/shared
COPY src/main/services/logger.js /app/src/main/services/logger.js
COPY src/main/services/petpack.js /app/src/main/services/petpack.js
COPY LICENSE /app/LICENSE
COPY --from=runtime-base / /opt/runtime-base
COPY platform/docker/media-worker/assemble-runtime.sh /usr/local/bin/assemble-media-runtime
RUN chmod 0555 /usr/local/bin/assemble-media-runtime \
  && /usr/local/bin/assemble-media-runtime \
  && mkdir -p /opt/media-root/app/licenses/ffmpeg-runtime \
  && cp /opt/static-ffmpeg/GPLv3.txt /opt/media-root/app/licenses/ffmpeg-runtime/FFMPEG-GPLv3.txt \
  && printf 'source=%s\nupstream=%s\nsha256=%s\nversion=7.0.2-static\n' "$(cat /opt/static-ffmpeg/source-url)" "$FFMPEG_STATIC_FALLBACK_URL" "$FFMPEG_STATIC_SHA256" > /opt/media-root/app/FFMPEG_RUNTIME_SOURCE.txt

FROM runtime-base

ENV NODE_ENV=production \
    NODE_PATH=/app/platform/node_modules \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe
WORKDIR /app/platform

COPY --from=build --chown=10001:10001 /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=10001:10001 /app /app
COPY --from=build /opt/media-root/ /
COPY --chown=10001:10001 platform/docker/media-worker/work-root /work

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["src/runtime/start-studio-worker.js"]
