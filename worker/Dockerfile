FROM node:22-alpine

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
ENV PORT=8080
ENV AI_LIVE_WORKER_MODE=fake
ENV AI_LIVE_MEDIA_ROOT=/app/media

WORKDIR /app
COPY --chown=node:node worker ./worker
RUN mkdir -p /app/media && chown node:node /app/media

USER node
EXPOSE 8080
CMD ["node", "worker/ai-live-worker.mjs"]
