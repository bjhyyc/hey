FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

ENV NODE_ENV=production
WORKDIR /app/platform

COPY platform/package.json platform/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY platform/src ./src
COPY src/shared /app/src/shared
COPY LICENSE /app/LICENSE

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:adcd20c7b4c988b73cbfbddb26d2eee574571e6d7c9ffea29b3821e0690efb77

ENV NODE_ENV=production
WORKDIR /app/platform

COPY --from=build --chown=10001:10001 /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=10001:10001 /app /app

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["src/runtime/start-production-auth-api.js"]
