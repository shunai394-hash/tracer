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
3. Build a container image with FFmpeg and health endpoint; run it in a
   separate worker service, not in a Vercel Function. The local-only FFmpeg
   renderer now creates MP4 segments from a still slate, TTS audio, and optional
   looped BGM. It rejects network inputs and writes only local MP4 files.
4. Select and verify one destination. The first adapter can use generic RTMP
   output, but platform-specific comment/API features remain off until reviewed.
5. Run a 30-minute local/sandbox rehearsal with synthetic comments and test media.
6. Run a supervised private/unlisted stream only after destination authorization
   and policy review. Measure reconnects, speech latency, dropped frames, and
   cost before expanding duration.

## Not yet implemented

- RTMP FFmpeg publisher or container deployment
- RTMP publishing or platform authentication
- Destination-specific comment ingestion
- Real-time product rotation and live TTS/BGM orchestration (rotation is
  currently simulated by the fake control API)
- Reconnect supervisor, durable queue, heartbeat persistence, and operator UI
- Any unattended or 24-hour broadcast

The existence of this contract does not mean a stream can be started today.
