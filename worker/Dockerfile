FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080
ENV AI_LIVE_WORKER_MODE=fake

WORKDIR /app
COPY worker/ai-live-worker.mjs ./ai-live-worker.mjs

USER node
EXPOSE 8080
CMD ["node", "ai-live-worker.mjs"]
