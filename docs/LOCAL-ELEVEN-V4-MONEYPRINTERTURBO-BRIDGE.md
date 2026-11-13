# Local Eleven v4 → MoneyPrinterTurbo audio bridge

This bridge downloads one MP3 per explicitly supplied script line from TRACER's existing admin-only Eleven v4 Turbo endpoint. It runs on the operator's Windows PC; audio files are written locally. It does not upload video, expose a local port, trigger a Vercel render, retry paid generations, or publish content.

## Requirements

- PowerShell 7+
- TRACER production or trusted HTTPS base URL
- Existing TRACER_ADMIN_TOKEN and ELEVENLABS_VOICE_ID supplied as local process environment variables
- Server-side ELEVENLABS_API_KEY already configured in TRACER
- Confirm ElevenLabs account access, plan, credits, and current pricing before the first paid request

Do not paste tokens or API keys into chat, source files, JSON scripts, or command-line arguments. Set them locally using a secure secret manager or process-scoped environment setup. Never commit them.

## Input

Create a UTF-8 JSON file containing an array of { "id": "...", "text": "..." } entries. IDs must be unique and contain only letters, numbers, underscore, or hyphen. Each line must contain 1–1,200 characters. Convert uncertain kanji readings to hiragana before generation.

Example file: scripts/video-script.example.json.

## Run

PowerShell:
- Set TRACER_BASE_URL to https://tracer-pied-alpha.vercel.app
- Set TRACER_ADMIN_TOKEN and ELEVENLABS_VOICE_ID locally; do not echo their values.
- Run: .\scripts\generate-eleven-v4-clips.ps1 -InputJson .\scripts\video-script.example.json

The script sends one explicit POST per line, sequentially, to /api/admin/ai-live/eleven-v4-turbo. It saves {id}.mp3 files under artifacts/eleven-v4. It stops at the first failure and does not automatically retry; already generated files remain available. A rerun must be an intentional operator action because it may incur additional credits.

## Quality gate

After generation, transcribe the MP3 files with faster-whisper and compare each transcript with its source line. Regenerate only a failed line after reviewing the mismatch and confirming the additional cost. Do not assemble the final video until all lines pass. Audio assembly, ducked BGM, 0.3-second narration offset, 1.2-second tail fade, and final five-line timing verification remain separate steps until independently implemented and tested.

## Security and scope

- HTTPS is required; HTTP is accepted only for loopback development.
- Credentials are sent only in the Authorization header and are never written to output files.
- No retry, parallel generation, scheduled generation, product mutation, order action, video upload, or social posting is performed.
- The bridge does not call MoneyPrinterTurbo private internals. It produces local MP3 assets for the next, separately validated integration step.

## Automatic transcript comparison

Install faster-whisper on the Windows PC (CPU int8 is used; the default `base` model is intentionally modest):

```powershell
py -m pip install faster-whisper
py .\scripts\check-eleven-v4-transcripts.py --self-test
py .\scripts\check-eleven-v4-transcripts.py --input-json .\scripts\video-script.example.json
```

The checker reads matching `{id}.mp3` files from `artifacts/eleven-v4`, transcribes Japanese, and writes `artifacts/eleven-v4/transcription-report.json`. It normalizes Unicode, whitespace, and punctuation, then computes a character similarity score. The default review threshold is 0.88; adjust only after listening to representative clips. Missing files and transcription failures are reported as non-passing. Exit code 1 means at least one clip needs review.

A PASS is only an automated screening result: similar text can still contain a wrong kanji reading, unnatural intonation, or a clipped ending. Listen to every clip. If a line fails, review the transcript and regenerate only that line manually, after confirming the additional ElevenLabs credit cost. The checker never calls ElevenLabs and never regenerates audio.
