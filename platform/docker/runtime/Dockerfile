FROM node:22.22.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/platform

RUN groupadd --gid 10001 petpack \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin petpack

COPY platform/package.json platform/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --chown=10001:10001 platform/src ./src
COPY --chown=10001:10001 src/shared /app/src/shared

USER 10001:10001
CMD ["node", "src/runtime/start-production-auth-api.js"]
