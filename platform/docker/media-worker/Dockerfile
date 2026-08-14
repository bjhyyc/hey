FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build with the repository root as context. The worker intentionally receives
# only private object-store downloads and server job IDs; no browser secrets are
# copied into this image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY platform ./platform
COPY src/shared ./src/shared

USER node

# Deployment supplies the process entrypoint, ModelArk/Kaipay credentials, and
# local segmentation implementation through its orchestrator. This image only
# provides the deterministic FFmpeg/Node worker runtime.
