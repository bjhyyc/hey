FROM gcr.io/distroless/cc-debian12:nonroot@sha256:adcd20c7b4c988b73cbfbddb26d2eee574571e6d7c9ffea29b3821e0690efb77 AS runtime-base

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true update \
  && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::ForceIPv4=true install -y --no-install-recommends ffmpeg \
  && ffmpeg -version >/dev/null \
  && ffprobe -version >/dev/null \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/platform

COPY platform/package.json platform/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY platform/src ./src
COPY src/shared /app/src/shared
COPY LICENSE /app/LICENSE
COPY --from=runtime-base / /opt/runtime-base
COPY platform/docker/media-worker/assemble-runtime.sh /usr/local/bin/assemble-media-runtime
RUN chmod 0555 /usr/local/bin/assemble-media-runtime \
  && /usr/local/bin/assemble-media-runtime

FROM runtime-base

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe
WORKDIR /app/platform

COPY --from=build --chown=10001:10001 /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=10001:10001 /app /app
COPY --from=build /opt/media-root/ /

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["src/runtime/start-studio-worker.js"]
