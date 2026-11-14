# Resident AI live worker. Build from the repository root:
#   docker build -f worker/Dockerfile -t tracer-ai-live-worker .
# This image is a long-running process. Do not deploy it as a Vercel Function.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY lib/ai-live ./lib/ai-live
COPY worker/ai-live-resident.mjs ./worker/ai-live-resident.mjs

# The non-root node user must be able to create the lock and state files.
RUN mkdir -p /var/lib/tracer-ai-live \
  && chown -R node:node /var/lib/tracer-ai-live
ENV TRACER_AI_LIVE_STATE_DIR=/var/lib/tracer-ai-live

USER node
CMD ["node", "--experimental-strip-types", "--no-warnings", "worker/ai-live-resident.mjs"]
