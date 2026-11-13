# TRACER AI-live: Mirelo SFX 2.0

This integration is an optional post-production step for pre-rendered clips. It is not a real-time speech synthesizer and does not fix Japanese pronunciation. It preserves speech in the source clip and asks Mirelo SFX 2.0 to generate synchronized sound for the video.

## Free-credit safety

- Configure `MIRELO_API_KEY` as a server-only environment variable. Never use a `NEXT_PUBLIC_` variable and never paste the key into chat or source code.
- The route accepts 1–30 seconds per request and one variant only.
- Every request first calls Mirelo preflight and account status.
- `action: "quote"` is the default and does not generate audio or spend credits.
- `action: "generate"` proceeds only if the quote is affordable, credit provisioning is ready, and the required credits fit inside the actual credit ledger balance. It deliberately does not use enabled overage headroom to pass this gate.
- If the free balance is insufficient, generation is refused; the route will not enable overage or buy credits.
- Output includes a temporary provider result URL. Download it promptly; Mirelo result URLs expire.

Mirelo Free currently advertises 5,000 credits/month and watermarked exports. The provider's API access and credit-metering behavior should be verified for the specific account before enabling this route in production.

## Endpoint

`POST /api/admin/ai-live/mirelo-sfx`

Requires the same automation authorization as other admin AI-live endpoints.

Quote only (no credits charged):

```json
{
  "videoUrl": "https://public.example/video.mp4",
  "durationSeconds": 10,
  "prompt": "Natural room ambience and subtle object handling; no music",
  "negativePrompt": "background music, added voices",
  "action": "quote"
}
```

Generate after the quote is affordable from included credits:

```json
{
  "videoUrl": "https://public.example/video.mp4",
  "durationSeconds": 10,
  "prompt": "Natural room ambience and subtle object handling; no music",
  "negativePrompt": "background music, added voices",
  "action": "generate"
}
```

Poll an asynchronous job:

`GET /api/admin/ai-live/mirelo-sfx?jobId=JOB_ID`

The video must be accessible to Mirelo over public HTTPS. Use footage you own or are authorized to process. This endpoint does not publish to TikTok, alter product listings, create orders, or change commerce data.
