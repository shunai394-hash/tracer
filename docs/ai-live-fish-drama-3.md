# TRACER AI-live: Fish Audio Drama 3

This is an optional, admin-authenticated short-clip TTS endpoint for testing more expressive Japanese narration. It does not change the local preview's browser speech, enable public use, or connect live TikTok comments. The model is selected server-side as `drama-3`.

## Setup

1. Create a Fish Audio API key in your account.
2. Add it to the Vercel server environment as `FISH_API_KEY` (never `NEXT_PUBLIC_FISH_API_KEY`; never commit or paste the key into chat).
3. Use a `referenceId` for a voice you own or have permission to use. Do not clone or impersonate a real person's voice without consent.
4. Keep this route behind the existing automation authorization.

## Endpoint

`POST /api/admin/ai-live/fish-drama-3`

Request JSON:

```json
{
  "text": "[warm, friendly, natural Japanese delivery] こんにちは。こちらはTRACERの音声テストです。",
  "referenceId": "YOUR_AUTHORIZED_VOICE_REFERENCE_ID"
}
```

The response is MP3 audio on success. On errors, the endpoint returns a small JSON error object. Maximum input length is 1,200 characters; requests time out after 25 seconds and are not automatically retried.

## Browser preview

After deployment, open `/ai-live-drama-preview.html` to compare one explicitly requested Drama 3 clip with the existing browser speech preview. Enter `TRACER_ADMIN_TOKEN` manually and a permitted Fish Audio voice reference ID. The page sends the token only to the same-origin TRACER endpoint, does not persist it, and clears the field after a successful response. The token is still present in browser memory while the request is in progress; use only on a trusted device and sign out/close the page afterward. The page does not call Fish Audio directly and never receives `FISH_API_KEY`.

The original `/ai-live-preview.html` remains a local-only browser-speech demo with no API calls. The Drama 3 page makes a provider request only when the user presses Generate.

## Cost and safety

- The API is paid; it is not a free-tier integration. The official launch announcement says Drama 3 API pricing is discounted 80% through November 12, 2026. Confirm the current rate and account billing in Fish Audio before use.
- There is no automatic generation, background job, retry, or fallback. Each POST is an explicit generation request and may incur charges.
- Start with one short Japanese sample, listen for pronunciation and latency, then compare it with the browser TTS and the Mirelo SFX post-production path.
- This endpoint is limited to short clips and is not yet connected to the AI avatar UI or real-time comment pipeline.
- The official model announcement describes Drama 3 as open-weight under Fish Audio Community License v1.0. Hosting the model as a service for third parties requires a separate license; review the current terms before any commercial deployment.
