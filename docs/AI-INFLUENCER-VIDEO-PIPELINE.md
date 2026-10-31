# TRACER × MoneyPrinterTurbo × VoiceStudio × ElevenLabs SFX v3

## Goal

Use MoneyPrinterTurbo as a local short-video rendering worker, VoiceStudio as a local speech workflow service, and ElevenLabs SFX v3 for explicitly requested sound-design previews. TRACER remains the source of truth for product facts. Keep local rendering off Vercel.

## Responsibilities

- **TRACER**: selects only verified, published, orderable, in-stock products and supplies approved public facts.
- **VoiceStudio / Eleven v4**: creates narration and character speech. Narration and real-time conversation are separate workloads.
- **ElevenLabs SFX v3**: creates short environmental, foley, and designed sound effects; it is not a replacement for Japanese narration.
- **MoneyPrinterTurbo**: assembles approved footage, captions, narration, and sound assets into a local vertical video.
- **Human operator**: reviews factual claims, rights, audio mix, captions, and final output before posting.

## Current TRACER capabilities to reuse

- Admin-protected, read-only product feed: `GET /api/admin/ai-live/products`.
- Existing Eleven v4 Turbo preview route.
- New admin-only SFX v3 preview route: `POST /api/admin/ai-live/sfx-v3`.
- No automatic generation, scheduled SFX jobs, auto-posting, livestreaming, listing, order, inventory, procurement, or price actions are enabled.

The SFX route requires the existing `TRACER_ADMIN_TOKEN` or automation authentication and server-side `ELEVENLABS_API_KEY`. It accepts only an explicit POST request, has no automatic retry, limits prompts to 600 characters, and caps each preview at 8 seconds. The documented SFX v3 rate is 40 credits per requested second, so the maximum configured preview is 320 credits; the default six-second preview is capped at 240 credits. Check the account's actual credit balance and access before testing. SFX v3 has limited account/region availability; an `Unknown model` response means the account may not have access.

API: `POST https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128`, model `eleven_text_to_sound_v3`. The API returns audio bytes. Keep the API key server-side and never log prompts, keys, or audio.

## Three controlled sound-design tests

Use the following English prompts because SFX v3 prompt examples and guidance are English-oriented. Keep the same duration and prompt influence when comparing variants.

1. **Rainy entrance / shoe dryer** (6 seconds): `Rain falling steadily outside a small Japanese apartment entrance, a door opens, wet shoes are gently placed on the floor, intimate realistic foley, no music, no intelligible speech.`
2. **Beauty product tabletop** (6 seconds): `Quiet cozy vanity room, a small cosmetic jar is picked up and opened, a soft lid click and gentle product handling sounds, close-mic realistic foley, no music, no intelligible speech.`
3. **Festival ambience** (6 seconds): `Distant Japanese summer festival ambience at night, a few fireworks bloom in the sky, soft crowd reaction and outdoor air, cinematic but realistic, no music, no intelligible speech.`

Generate one sample per scene first. Do not batch-generate 3, 6, or 10 alternatives until quality and account cost are understood. For each sample record prompt, duration, provider status, generation latency, file size, subjective realism, unwanted artifacts, and whether speech remains intelligible when mixed with a separate narration track. The initial three tests are sound effects only; do not assume the API reliably embeds a Japanese spoken line in a specified environment. Test that separately in ElevenCreative/Studio if the account UI exposes the capability.

## Local machine fit

The reported Windows PC has 15.7 GB RAM and Intel Iris Xe integrated graphics. Start with one 30–45 second 9:16 video. Do not run large video rendering and voice generation concurrently until memory use and stability have been measured. Keep VoiceStudio at loopback `http://127.0.0.1:3900` and MoneyPrinterTurbo local; do not expose local worker ports publicly.

## Commercial and content rights

Check the ElevenLabs plan, output-use terms, account access and remaining credits before generation. Also verify the licenses of any footage, music, TTS model, voice, and reference samples. Do not clone another person's voice without permission. Keep product claims grounded in the TRACER feed. Require manual review before publishing.

## Windows setup

MoneyPrinterTurbo (Python 3.11+):

```powershell
powershell -ExecutionPolicy Bypass -File .\\scripts\\setup-moneyprinterturbo.ps1
```

VoiceStudio:

```powershell
irm https://voicestudio.sh/install.ps1 | iex
```

Official references:
- ElevenLabs SFX documentation: https://elevenlabs.io/docs/ja/overview/capabilities/sound-effects
- ElevenLabs Sound Generation API: https://elevenlabs.io/docs/ja/api-reference/text-to-sound-effects/convert
- VoiceStudio: https://voicestudio.sh/docs/quickstart
- MoneyPrinterTurbo: https://github.com/harry0703/MoneyPrinterTurbo
