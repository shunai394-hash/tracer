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
duration is 45 seconds and accepted values are 15–600 seconds. The default fake
mode only rotates simulated state. An explicitly injected media runtime can
resolve each product ID to a trusted video asset under `AI_LIVE_MEDIA_ROOT`;
when the product changes, FFmpeg is stopped and restarted with the new video.
This produces a brief on-air interruption during each switch, so it is a
functional first implementation rather than seamless frame-accurate switching.
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
node worker/media/test-create-ai-live-media-runtime.mjs\nnode worker/media/test-create-ai-live-platform-runtime.mjs
```

## Unified platform runtime

`media/create-ai-live-platform-runtime.mjs` now owns one session lifecycle:
start the media publisher, start both platform comment adapters, forward both
comment streams to the same media runtime, and stop the comment sources before
stopping media. If either adapter fails to start, both adapters are rolled back
and the media publisher is stopped. It accepts already-constructed adapters
and a media runtime; it does not acquire OAuth credentials, obtain TikTok LIVE
access, or enable production publishing. The default worker entrypoint remains
fake-only and does not instantiate this runtime.

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
contract-tested. The FFmpeg publisher, speech bridge, media session, and bounded reconnect supervisor can now be assembled into one media runtime. The HTTP worker can manage an explicitly injected runtime through start, product-context updates, stop, runtime-limit, lease-loss, and shutdown paths. This injection is not enabled by the default entrypoint: the HTTP service still refuses any mode other than `fake` and does not create a real publisher unless a host deliberately supplies the factory and its trusted options resolver. For injected media runtimes, product rotation now switches the FFmpeg video
asset using a trusted `resolveVideoForProduct(productId)` resolver. Each switch
restarts the FFmpeg publisher and can briefly interrupt the broadcast. Seamless
switching and production platform comment adapters remain future work. Before enabling publishing, wire
in a production secret manager and verify each YouTube/TikTok account's current
stream eligibility and platform policy requirements. Mount only approved
media files under `AI_LIVE_MEDIA_ROOT`; do not place stream keys in job JSON.


## YouTube OAuth credential bridge

The admin OAuth callback at `/api/admin/ai-live/youtube/callback` stores the refresh token as AES-256-GCM ciphertext in `ai_live_oauth_credentials`. The encryption key remains in deployment secrets. The worker retrieves the decrypted credential only over HTTPS from the internal `/api/admin/ai-live/youtube/credentials` endpoint using `AI_LIVE_WORKER_TOKEN`.

Required deployment secrets (not configured by this code change):
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_OAUTH_REDIRECT_URI` (must be the production callback URL)
- `AI_LIVE_OAUTH_ENCRYPTION_KEY` (32 bytes, base64 or 64-character hex)
- `AI_LIVE_WORKER_TOKEN` (at least 24 characters; same value in the app and worker)

The migration `20261107040000_ai_live_oauth_credentials.sql` must be applied before connecting. The admin-only `POST /api/admin/ai-live/youtube/connect` endpoint requires `Authorization: Bearer <TRACER_ADMIN_TOKEN>` and returns an authorization URL; the caller must navigate the same browser to that URL so the HttpOnly OAuth state cookie is retained. The callback never returns token material to the browser. The worker credential endpoint is separate and requires the worker token.

This completes secure token handoff only. It does not create a YouTube broadcast, bind a stream, start publishing, or authorize TikTok. Actual OAuth consent and production secret/migration setup remain operator steps.
