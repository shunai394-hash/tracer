# TRACER AI Live destination adapter readiness

This document separates platform authorization from local MP4 rendering. The
worker currently runs in fake mode only. Nothing in this document enables a
broadcast or stores destination credentials.

## Shared release gates

- A human operator confirms the destination account is eligible to broadcast.
- The worker receives only a logical destination ID and opaque secret reference.
  RTMP URLs, stream keys, OAuth tokens, cookies, and refresh tokens must never
  appear in job payloads, logs, health responses, or error messages.
- Destination credentials are resolved inside the worker from a deployment
  secret provider. The provider must support rotation and short-lived values.
- Start with a supervised, finite test session. Do not enable unattended or
  24-hour operation.
- Keep viewer-comment ingestion and AI replies disabled until platform scopes,
  moderation, disclosure, and current platform rules are reviewed.
- The first live test must use synthetic or explicitly approved media and
  current product facts. Stale or unverified product claims stop the segment.

## YouTube Live

YouTube Live Streaming API requires OAuth 2.0 for Live Streaming API methods.
A service account is not supported for linking to a YouTube channel. The
channel owner must have live streaming enabled.

Proposed sequence:

1. Complete server-side OAuth 2.0 consent for the channel owner and securely
   retain the refresh token in the deployment secret provider.
2. Create a broadcast with `liveBroadcasts.insert`, initially using an
   operator-approved non-public privacy setting for rehearsal.
3. Create or reuse a `liveStream` with `liveStreams.insert`; use the
   ingestion address returned by YouTube rather than hard-coding an endpoint.
4. Bind the broadcast and stream with `liveBroadcasts.bind`.
5. Start the encoder only after preflight succeeds. Transition to `testing`
   first; transition to `live` only after explicit operator confirmation.
6. Stop the encoder and transition/end the broadcast cleanly.

Required external setup: Google Cloud project, YouTube Data API v3 enabled,
OAuth web client, redirect URI, and a channel with Live enabled. Use the
narrowest scope that supports the required Live operations. Do not use a
service-account credential for the channel.

## TikTok LIVE

TikTok's third-party encoder path is not available to every account. The
operator must verify that the target account exposes LIVE Producer / external
streaming settings and can obtain a server URL and stream key.

For each broadcast:

1. The operator opens TikTok LIVE Center and obtains the current server URL
   and stream key for that LIVE session.
2. The values are entered into a short-lived secret slot, never into the
   worker job or general application logs.
3. The worker resolves the opaque secret reference immediately before
   connecting and rejects expired/missing credentials.
4. The operator starts the TikTok LIVE session in TikTok's own interface after
   confirming that the incoming encoder feed is healthy.
5. End the encoder and TikTok LIVE session explicitly. Expire the secret slot.

Do not assume TikTok stream keys are permanent or reusable. TikTok's own
third-party streaming setup describes a new server URL and stream key for each
new LIVE broadcast. Eligibility and interface availability can change by
account and region.

## Implementation order

1. Add a worker-side secret-provider interface with fake test fixtures.
2. Add destination preflight that returns only safe status codes; never return
   the secret values.
3. Implement YouTube OAuth and Live resource lifecycle separately from FFmpeg.
4. Implement TikTok custom RTMP as an operator-supplied, short-lived secret.
5. Add a bounded reconnect supervisor and a manual stop path.
6. Perform supervised platform tests only after the operator has completed
   external account authorization and credential setup.

## Current status

- Local FFmpeg MP4 rendering: implemented and covered by mock and real-FFmpeg
  integration tests.
- Worker lifecycle: fake adapter only.
- YouTube OAuth / Live API adapter: not implemented.
- TikTok LIVE custom RTMP adapter: not implemented.
- Secret-provider integration: not implemented.
- Real platform broadcast: disabled.
