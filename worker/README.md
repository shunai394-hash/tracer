# AI Live worker control service

This is the first isolated-container milestone for the AI Live pipeline. It is
intentionally a **fake lifecycle adapter**: it validates bounded jobs, exposes
authenticated start/stop/status endpoints, and simulates state. It does not
invoke FFmpeg, connect to TikTok or YouTube, or publish video/audio.

## Run locally

```sh
AI_LIVE_WORKER_TOKEN='replace-with-a-random-secret-at-least-32-characters' \
AI_LIVE_WORKER_MODE=fake node worker/ai-live-worker.mjs
```

Health checks:
- `GET /healthz` — process liveness
- `GET /readyz` — readiness and explicit publishing-disabled state

Authenticated API (Bearer token):
- `POST /v1/streams` — create an idempotent, bounded simulated stream
- `GET /v1/streams/:streamId` — read state
- `POST /v1/streams/:streamId/stop` — stop a simulated stream

The request contains a logical destination and opaque secret reference, never a
stream key or RTMP URL. Only YouTube Live and TikTok LIVE logical destinations
are accepted. Product facts older than 15 minutes are rejected. Maximum run
time is 30 minutes. Product segments rotate in round-robin order; the default
duration is 45 seconds and accepted values are 15–600 seconds. This rotation
is simulated control-plane state only and does not switch a real video feed.
The in-memory registry is not durable across restarts and must not be used for
production jobs.

Run the focused checks from the repository root:

```sh
node worker/test-ai-live-worker.mjs
node worker/platforms/test-normalize-comment.mjs
```

## Container

Build from the repository root:

```sh
docker build -f worker/Dockerfile -t tracer-ai-live-worker .
```

The image runs as the unprivileged `node` user. Set
`AI_LIVE_WORKER_TOKEN` through the deployment secret manager. Do not place
credentials in the image, job payload, logs, or health response.

## Next implementation gate

The FFmpeg publisher, destination secret resolver, persistent job registry,
reconnect supervisor, platform eligibility checks, and actual media/BGM
scheduler are not implemented. The service refuses any mode other than
`fake`, so it cannot accidentally start a real broadcast. Add YouTube and
TikTok publishing only after each account's stream-key/API eligibility and
platform policy checks are verified.
