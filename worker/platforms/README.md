# Platform adapter boundaries

The shared worker accepts only normalized comment events. Platform-specific
credentials and payloads stay inside each adapter and are never copied into the
comment-processing job.

## YouTube Live

Use the official YouTube Live Streaming API:
- Create/bind/transition broadcasts and streams through the Live Streaming API.
- Obtain the active chat ID from the broadcast's live-chat metadata.
- Prefer `liveChatMessages.streamList` for low-latency server-streaming rather
  than repeatedly polling `liveChatMessages.list`.
- Resume a disconnected chat stream using the last `nextPageToken`.
- Use channel-authorized OAuth credentials from the worker secret store.

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
