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
