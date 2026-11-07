# AI Live worker control service

This is an isolated-container milestone for the AI Live pipeline. The HTTP
control API still runs in **fake mode** and does not start a broadcast. A
separate FFmpeg publisher module now supports a controlled RTMP process, a
looped background video, MP3 speech on stdin, and an MP3/WAV/M4A BGM track mixed
at 18% volume. The worker also accepts an explicitly injected media-runtime
factory for lifecycle tests and controlled host integration. The default
entrypoint does not inject one and remains fake-only; do not treat this as a
live-ready deployment.

## Run locally

```sh
AI_LIVE_WORKER_TOKEN='replace-with-a-random-secret-at-least-32-characters' \
SUPABASE_URL='https://your-project.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='server-only-service-role-secret' \
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
When Supabase is configured, stream creation uses insert-only semantics,
then atomically claims a 45-second worker lease. The worker renews that lease
every 15 seconds and stops locally if it loses ownership. On process startup,
only validated `fake`-mode records are considered for recovery; the worker
reclaims an expired lease before restoring the segment index and remaining
runtime. Live-mode records are never resumed. The migration files must be
applied before starting the isolated worker. The default HTTP control plane still does not broadcast.

Run the focused checks from the repository root:

```sh
node worker/test-ai-live-worker.mjs
node worker/platforms/test-normalize-comment.mjs
node worker/platforms/test-tracer-speech-bridge.mjs
node worker/media/test-ffmpeg-publisher.mjs
node worker/media/test-live-media-session.mjs
node worker/media/test-reconnect-supervisor.mjs
node worker/media/test-ai-live-stream-runtime.mjs
node worker/media/test-create-ai-live-media-runtime.mjs
```

## Container

Build from the repository root:

```sh
docker build -f worker/Dockerfile -t tracer-ai-live-worker .
```

The image runs as the unprivileged `node` user. Set
`AI_LIVE_WORKER_TOKEN`, `SUPABASE_URL`, and
`SUPABASE_SERVICE_ROLE_KEY` through the deployment secret manager. The service-role
key is server-only. Do not place credentials in the image, job payload, logs,
or health response.

## Next implementation gate

The Supabase state adapter, insert-only start path, atomic lease claim,
lease-fenced heartbeat, and fake-mode restart recovery are implemented and
contract-tested. The FFmpeg publisher, speech bridge, media session, and bounded reconnect supervisor can now be assembled into one media runtime. The HTTP worker can manage an explicitly injected runtime through start, product-context updates, stop, runtime-limit, lease-loss, and shutdown paths. This injection is not enabled by the default entrypoint: the HTTP service still refuses any mode other than `fake` and does not create a real publisher unless a host deliberately supplies the factory and its trusted options resolver. Product rotation currently updates product context only; it does not yet switch the on-air video. The worker still has no production platform comment adapters. Before enabling publishing, wire
in a production secret manager and verify each YouTube/TikTok account's current
stream eligibility and platform policy requirements. Mount only approved
media files under `AI_LIVE_MEDIA_ROOT`; do not place stream keys in job JSON.
