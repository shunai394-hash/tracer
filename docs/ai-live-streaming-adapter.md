# TRACER AI Live streaming adapter

## Scope

This is the provider-neutral boundary between the TRACER control plane and a
long-running streaming worker. It is a contract and rollout plan, not a working
RTMP publisher. The current AI Live product feed, comment routing, Fish Audio
speech generation, and browser-side drama/BGM mixdown remain separate systems.

## Architecture

- **TRACER control plane (Vercel):** chooses approved product segments, issues
  bounded jobs, receives health state, and exposes operator start/stop controls.
  It must not run FFmpeg or hold an HTTP request open for the duration of a stream.
- **Streaming worker (separate container):** resolves destination credentials
  from its own secret store, renders/composes audio and video, publishes to the
  configured destination, and reports heartbeats.
- **Media pipeline:** consumes approved audio assets and a licensed/reusable
  avatar/video source. It must support a silent fallback slate and a clear
  operator stop path.
- **Destination adapter:** maps the worker's generic start/stop/health lifecycle
  to a platform-specific RTMP or supported live API. Platform-specific
  authorization, comment ingestion, and policy checks stay in this adapter.

## Contract rules

1. Job payloads contain a logical destination and opaque secret reference only.
   They must never contain RTMP URLs, stream keys, access tokens, or cookies.
2. Every job has a finite `maxRuntimeSeconds`; unattended 24/7 mode is not
   enabled by default.
3. A segment is eligible only when TRACER has current, approved product facts.
   The worker must stop or skip a segment when facts expire or inventory becomes
   unverified; it must not invent price, stock, shipping, or product claims.
4. Start/stop operations must be idempotent by `streamId`. Duplicate starts
   must not create duplicate broadcasts.
5. Health events expose only safe error codes and timestamps. Never log stream
   credentials, full viewer comments, customer/order data, or private asset URLs.
6. Reconnect attempts must be bounded and back off. A destination rejection,
   stale facts, operator stop, or exhausted reconnect budget moves the job to a
   stopped/failed state and alerts the operator.
7. Live comment ingestion and posting are disabled until the destination's
   current platform rules, account eligibility, AI disclosure, and API scopes
   have been verified.

## Initial rollout

1. Implement a worker-side fake adapter and lifecycle contract tests.
2. Add an authenticated control-plane job API with idempotency and bounded
   runtime. Keep it read-only with respect to listings, inventory, and orders.
3. Build a container image with pinned FFmpeg and health endpoint; run it in a
   separate worker service, not in a Vercel Function.
4. Select and verify one destination. The first adapter can use generic RTMP
   output, but platform-specific comment/API features remain off until reviewed.
5. Run a 30-minute local/sandbox rehearsal with synthetic comments and test media.
6. Run a supervised private/unlisted stream only after destination authorization
   and policy review. Measure reconnects, speech latency, dropped frames, and
   cost before expanding duration.

## Resident worker

`worker/ai-live-resident.mjs` is the long-running process. It listens on `127.0.0.1` only, keeps a pid lock so a second process exits, and writes `state.json` in `TRACER_AI_LIVE_STATE_DIR`.

- `POST /start` with `destination: "loopback"` starts the local session. `publicBroadcast` stays false.
- `POST /reconnect` counts a bounded reconnect. After three recoveries the session fails closed.
- `POST /stop` and `SIGTERM` stop the session and remove the lock.
- If the process is killed, the next start reads the saved session and reconnects once.
- `destination: "youtube"` returns `youtube_approval_required`. `destination: "tiktok"` returns `tiktok_approval_required`. Neither opens a socket to the platform.
- Jobs that contain an RTMP URL, stream key, or token field are rejected and not written to the state file.

Run it with `TRACER_AI_LIVE_STATE_DIR` set to a directory outside the repo. Do not run this process inside a Vercel function.

## What runs today

- The OBS page rotates sellable product scripts, ducks BGM during speech, and switches 16:9 or 9:16 layout.
- `/api/admin/ai-live/session` reports whether YouTube and TikTok credentials exist and builds the next factual script. Its `live` field stays false. It does not start a broadcast.
- `node --experimental-strip-types worker/ai-live-runner.mjs --rehearsal` checks the program on a long-running machine. Do not run FFmpeg inside a Vercel function.

## Still blocked on platform approval

- YouTube goes live only from the worker, after `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REFRESH_TOKEN` are set, and only when `worker/platforms/youtube-live-broadcast-manager.mjs` receives `confirmEncoderActive: true`.
- TikTok does not offer this app a public API to open a live or read comments. Desktop delivery requires TikTok's own approval at https://livecenter.tiktok.com/producer. The short-lived server URL and stream key belong in the worker environment as `TIKTOK_RTMP_URL` and `TIKTOK_STREAM_KEY`. Unofficial login automation is not used.

## Not yet implemented

- Vercel では長時間の配信処理を実行しない。配信先が未承認のまま開始したことにはしない。無人の24時間配信は未実装で、stream key はワーカーの環境変数にだけ置く。
- Starting YouTube or TikTok from the Vercel deployment
- Posting viewer replies back to YouTube or TikTok
