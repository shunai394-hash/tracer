# TRACER AI-live: Eleven v4 / v4 Turbo

Optional admin-authenticated endpoint for manually generating a short Japanese voice sample with ElevenLabs. The preview supports both `eleven_v4` and `eleven_v4_turbo` using the same authorized voice ID and test text. It does not enable public use, connect TikTok, or automatically synthesize replies to live comments.

## Setup

1. Confirm your ElevenLabs account can use both `eleven_v4` and `eleven_v4_turbo` and check current API pricing/credits.
2. Add the API key to the server environment as `ELEVENLABS_API_KEY`; never use a `NEXT_PUBLIC_` variable or commit the key.
3. Select a voice ID you own or have permission to use. Do not clone or impersonate a real person's voice without consent.
4. Keep this route behind the existing automation authorization.

## Endpoint

`POST /api/admin/ai-live/eleven-v4-turbo`

Request JSON:

```json
{
  "text": "こんにちは。こちらはTRACERの音声テストです。今日はおすすめ商品をご紹介します！",
  "voiceId": "YOUR_AUTHORIZED_VOICE_ID"
}
```

Returns MP3 audio on success. Maximum input is 1,200 characters; the provider connection times out after 25 seconds and is not automatically retried. The browser offers only the two allowlisted model IDs; the server rejects every other model ID. The default is `eleven_v4_turbo`. The endpoint accepts an authorized voice ID and a fixed model allowlist, not an arbitrary provider model.

## Transport

Standard `eleven_v4` uses the HTTP Text to Dialogue stream endpoint (`POST /v1/text-to-dialogue/stream`) and returns the streamed MP3 response. `eleven_v4_turbo` uses the Text to Dialogue WebSocket (`/v1/text-to-dialogue/stream-input`) for low-latency generation; it registers the authorized voice, sends the dialogue input, and collects audio chunks until the final marker. Both transports receive the selected model ID server-side. The official guidance recommends standard v4 for content creation/long-form audio and v4 Turbo for real-time agents.

## Cost and safety

- This API call can incur usage charges. Check the current account plan, credit balance, model availability, and current pricing before the first request.
- No automatic generation, background job, retry, or fallback is enabled. Each POST is an explicit generation request.
- The server does not log the text, voice ID, or audio. API credentials stay server-side.
- The endpoint is not connected to the AI avatar UI or real-time comment pipeline.
- Test one short Japanese sample first; compare pronunciation, emotion-tag behavior, time to audio, and actual credits consumed against browser speech and Fish Audio Drama 3.
- Model inference latency does not include network and application latency.
