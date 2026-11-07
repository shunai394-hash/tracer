FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV AI_LIVE_WORKER_MODE=fake
ENV FFMPEG_PATH=/usr/bin/ffmpeg

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/ai-live-worker.mjs ./ai-live-worker.mjs
COPY worker/ffmpeg-media.mjs ./ffmpeg-media.mjs

USER node
EXPOSE 8080
CMD ["node", "ai-live-worker.mjs"]
