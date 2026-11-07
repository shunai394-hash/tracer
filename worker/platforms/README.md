# Platform adapter boundaries

The shared worker accepts only normalized comment events. Platform-specific
credentials and payloads stay inside each adapter and are never copied into the
comment-processing job.

## YouTube Live

Use the official YouTube Live Streaming API:
- Create/bind/transition broadcasts and streams through the Live Streaming API.
- Obtain the active chat ID from the broadcast's live-chat metadata.
- Prefer `liveChatMessages.streamList` for low-latency server-streaming when
  the host supplies a compatible transport. The implemented fallback uses
  the official `liveChatMessages.list` endpoint and honors the API-provided
  `pollingIntervalMillis`.
- Resume after reconnect using the last `nextPageToken`.
- Supply a channel-authorized OAuth access token through an injected provider;
  refresh and secure token storage remain the host's responsibility.

Official references:
- https://developers.google.com/youtube/data/live/reference/rest
- https://developers.google.com/youtube/data/live/reference/rest/v3/liveChatMessages/streamList
- https://developers.google.com/youtube/data/live/streaming-live-chat

## TikTok LIVE

- RTMP publishing is possible only when the account's LIVE setup provides a
  current server URL and stream key. These values are session-sensitive and
  must be injected through a secret manager, never included in job payloads,
  source code, logs, or status responses.
- TikTok does not expose a general public real-time LIVE chat endpoint in the
  public developer documentation reviewed for this integration. The Research
  API video-comments endpoint is for comments on published videos, not a
  real-time LIVE chat feed.
- Therefore, comment ingestion is accepted only from an explicitly approved
  TikTok LIVE connector. Unofficial scraping/reverse-engineered clients are
  not enabled.
- The TikTok normalizer requires the source marker
  `approved_tiktok_live_connector`; it does not itself connect to TikTok.

References:
- https://developers.tiktok.com/doc/search?q=live
- https://developers.tiktok.com/docs/en/research-api-specs-query-video-comments
- https://docs.byteplus.com/en/docs/byteplus-livesaas/Synchronizing_a_live_stream_from_AI_Live_to_third-party_platforms

## Implemented adapter modules

- `youtube-live-chat-adapter.mjs` consumes an async-iterable transport,
  normalizes text messages, retains the latest `nextPageToken`, and reconnects
  with bounded exponential backoff.
- `youtube-live-chat-list-transport.mjs` calls the official YouTube Data API v3
  `liveChatMessages.list` endpoint, obtains a fresh access token from an
  injected provider on each request, and respects `pollingIntervalMillis`.
  OAuth consent, refresh-token storage, and broadcast/chat discovery remain
  deployment-host responsibilities.
- `google-oauth-access-token-provider.mjs` refreshes a stored offline refresh
  token against Google's official token endpoint, coalesces concurrent refresh
  requests, and caches access tokens only in worker memory. The host must
  implement OAuth consent/callback, securely store the refresh token, and
  provide credentials through `credentialsProvider`.
- `tiktok-live-connector-adapter.mjs` consumes an injected approved connector
  async iterable, validates its source marker, normalizes comments, and applies
  bounded reconnect backoff. It does not implement or imply a generally
  available official TikTok LIVE chat API.

These are adapter contracts and lifecycle implementations; neither one is
connected to production account credentials or enabled in the default worker.

## Dual-platform orchestration

`dual-platform-comment-bridge.mjs` starts both adapters concurrently and
forwards their normalized events to the same media runtime. It binds the shared
handler before starting either stream, rolls both back if one startup fails,
and stops both together. Supply an authenticated YouTube transport and an
approved TikTok connector when constructing the adapters. This coordinator
does not create credentials or enable live mode in the default worker.

## Shared event contract

Both platform adapters produce only:
- Stable platform-scoped event ID
- Platform ID
- Plain text comment (maximum 2,000 characters)
- ISO timestamp
- Event kind

Display names, profile images, profile URLs, payment data, and other author
metadata are discarded before the AI reply pipeline. Duplicate event IDs are
suppressed by a bounded in-memory deduplicator. Production 24-hour operation
will require a durable dedupe store and reconnect checkpoints.

## YouTube OAuth connection flow

The OAuth helpers now cover the protocol pieces, but they do not silently
connect an account:

1. An authenticated TRACER admin calls
   `createGoogleYouTubeAuthorizationRequest` with the registered OAuth client
   ID and exact callback URL.
2. Store the returned random `state` server-side with a short expiry and bind
   it to that admin session before redirecting to Google.
3. On callback, atomically consume the stored state and verify it with
   `verifyGoogleOAuthState`. Reject missing, expired, reused, or mismatched
   state values.
4. Exchange the one-time code with
   `exchangeGoogleYouTubeAuthorizationCode`. Persist the returned refresh
   token in the deployment secret store; do not return tokens to the browser.
5. Configure `createGoogleOAuthAccessTokenProvider` to load the channel's
   client ID, optional client secret, and refresh token from that secret store.

The requested scope is `https://www.googleapis.com/auth/youtube`, needed for
the planned authenticated Live Streaming API workflow. Google consent, OAuth
client registration, callback hosting, state persistence, secure token storage,
broadcast creation/binding, and live publishing still require deployment
configuration and an actual channel-owner authorization.


## YouTube broadcast and ingest lifecycle

- `youtube-live-broadcast-manager.mjs` uses the official Live Streaming API to create a dedicated RTMP ingest stream, create a scheduled broadcast, and bind the two resources.
- The ingest URL and stream key are passed directly to the injected secret-manager callback. The manager returns only an opaque secret reference; status responses never expose ingest credentials.
- The broadcast is created as **unlisted** by default, with auto-start/auto-stop disabled and monitor stream disabled. This allows a controlled explicit transition to live without a mandatory testing phase.
- The host must start FFmpeg using the opaque secret reference, verify the YouTube ingest stream reports `active`, and explicitly call `startBroadcast({ confirmEncoderActive: true })`. The manager checks the binding, readiness, and active ingest status before transitioning the broadcast to `live`.
- `completeBroadcast` ends the YouTube broadcast but deliberately does not stop the local encoder; the host must coordinate both sides and verify shutdown.
- Contract tests cover resource creation/binding, lifecycle transitions, encoder confirmation, status checks, and that stream keys are not returned.

This is a production-oriented API module, not a live-enabled worker deployment. A real secret-manager adapter, channel OAuth consent, the Supabase migration, and explicit operator-controlled orchestration are still required. Never use a raw YouTube stream key as a job payload or log field.


## TRACER-managed YouTube chat client

`create-tracer-youtube-live-chat-client.mjs` now composes the TRACER worker-only encrypted-credential endpoint, Google OAuth refresh provider, official `liveChatMessages.list` transport, and normalized YouTube chat adapter. The caller supplies the liveChatId returned by the broadcast API after the broadcast has transitioned to live. The adapter resumes with the last page token and honors the API polling interval. This factory connects only YouTube chat; TikTok still requires the approved connector supplied by the host.


`create-tracer-youtube-live-control.mjs` is the production-host composition entrypoint for the YouTube broadcast manager. It loads encrypted TRACER OAuth credentials, refreshes Google access tokens in memory, and supplies them to the official broadcast/stream API controller. The host still injects its durable RTMP secret manager. If resource creation fails after the ingest key was persisted, the manager invokes the optional secret deletion callback and attempts to delete the partially created YouTube resources.


## Production YouTube Live session composition

`create-tracer-youtube-live-session-runtime.mjs` composes the encrypted TRACER
OAuth credential endpoint, official YouTube broadcast manager, FFmpeg media
runtime, and official Live Chat client into one start/stop lifecycle.

The deployment must inject a real secret manager with three operations:

- `persistStreamSecret({ platform, streamId, ingestionAddress, streamName })`
  stores the RTMP ingest credentials and returns an opaque reference.
- `resolveStreamSecret({ destination, secretRef })` resolves that reference
  just-in-time to `{ outputUrl }` for FFmpeg only.
- `deleteStreamSecret(secretRef)` removes the stored credential after a
  cancelled or completed session.

The session creates the broadcast and stream, starts the encoder, waits for
YouTube to report an active ingest, explicitly transitions the broadcast to
live, and then attaches official Live Chat. Stop detaches chat, completes the
broadcast, stops media, and removes the ingest secret. A failed pre-live start
attempts to cancel the pending broadcast and stream.

This composition is not enabled by the default worker entrypoint. Production
still requires the Supabase OAuth migration, configured TRACER worker secrets,
a connected/authorized YouTube channel, durable secret-manager implementation,
and a deployment host that invokes this composition. TikTok still requires a
separately approved connector; no unofficial chat scraping is used.


## Encrypted YouTube RTMP secret persistence

`supabase-youtube-stream-secret-store.mjs` provides a durable Supabase-backed
secret store for YouTube ingest address + stream key. It encrypts the payload
with AES-256-GCM before writing the database; only ciphertext, IV, and auth tag
are stored. The opaque UUID reference is the only value returned to session
or job orchestration. FFmpeg resolves the decrypted RTMP URL just-in-time
inside the worker process.

Apply migration `20261108010000_ai_live_stream_secrets.sql` and configure
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`AI_LIVE_OAUTH_ENCRYPTION_KEY` in the isolated worker. The production session
factory can now build this store automatically; deployments may still inject
an external secret manager instead. No migration has been applied to production
by this code change.
