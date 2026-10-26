# TRACER AI-live: Eleven v4 Turbo

Optional admin-authenticated endpoint for manually generating a short Japanese voice sample with ElevenLabs. It does not change the browser preview, enable public use, connect TikTok, or automatically synthesize replies to live comments.

## Setup

1. Confirm your ElevenLabs account can use the `eleven_v4_turbo` model and check current API pricing/credits.
2. Add the API key to the server environment as `ELEVENLABS_API_KEY`; never use a `NEXT_PUBLIC_` variable or commit the key.
3. Select a voice ID you own or have permission to use. Do not clone or impersonate a real person's voice without consent.
4. Keep this route behind the existing automation authorization.

## Endpoint

`POST /api/admin/ai-live/eleven-v4-turbo`

Request JSON:

```json
{
  "text": "[warm, friendly] こんにちは。こちらはTRACERの音声テストです。[excited] 今日はおすすめ商品をご紹介します！",
  "voiceId": "YOUR_AUTHORIZED_VOICE_ID"
}
```

Returns MP3 audio on success. Maximum input is 1,200 characters; requests time out after 25 seconds and are not automatically retried. The model and output format are fixed server-side. The endpoint accepts a voice ID, not an arbitrary model ID.

## Cost and safety

- This API call can incur usage charges. Check the current account plan, credit balance, model availability, and current pricing before the first request.
- No automatic generation, background job, retry, or fallback is enabled. Each POST is an explicit generation request.
- The server does not log the text, voice ID, or audio. API credentials stay server-side.
- The endpoint is not yet connected to the AI avatar UI or real-time comment pipeline.
- Test one short Japanese sample first; compare pronunciation, emotion-tag behavior, time to first audio, and actual credits consumed against browser speech and Fish Audio Drama 3.
- ElevenLabs' documented model guidance describes `eleven_v4_turbo` as a real-time expressive TTS option. Reported model inference latency does not include network and application latency.
