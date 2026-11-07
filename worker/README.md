# AI Live worker control service

This is an isolated-container milestone for the AI Live pipeline. The HTTP
control API still runs in **fake mode** and does not start a broadcast. A
separate FFmpeg publisher module now supports a controlled RTMP process, a
looped background video, MP3 speech on stdin, and an MP3/WAV/M4A BGM track mixed
at 18% volume. The publisher is not yet wired to the HTTP stream lifecycle or
a production secret manager; do not treat this as a live-ready deployment.

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
node worker/platforms/test-tracer-speech-bridge.mjs
node worker/media/test-ffmpeg-publisher.mjs
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

The FFmpeg publisher module is implemented and contract-tested, and FFmpeg is
installed in the container image. It is not yet connected to the HTTP control
API, persistent job registry, reconnect supervisor, or live comment/audio
scheduler. The HTTP service still refuses any mode other than `fake`, so it
cannot accidentally start a real broadcast. Before enabling publishing, wire
in a production secret manager and verify each YouTube/TikTok account's current
stream eligibility and platform policy requirements. Mount only approved
media files under `AI_LIVE_MEDIA_ROOT`; do not place stream keys in job JSON.
