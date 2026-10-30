# TRACER × MoneyPrinterTurbo × VoiceStudio — local creator pipeline

## Goal

Use MoneyPrinterTurbo as a **local short-video rendering worker** and VoiceStudio as a **local speech generation / voice workflow service** for TRACER AI-influencer content. Keep TRACER as the source of truth for product facts. Keep audio and video generation off Vercel to avoid serverless execution time and cost.

## Responsibilities

- **TRACER**: selects only verified, published, orderable, in-stock products and supplies the public facts used in scripts.
- **VoiceStudio**: creates locally generated narration and character voice audio; can also provide transcription/dubbing workflows where the selected engine supports the language and task.
- **MoneyPrinterTurbo**: assembles scripts, captions, footage and generated audio into a local vertical video.
- **AI LIVE**: separate real-time comment understanding and response path. It may use VoiceStudio's local speech endpoint only after latency and streaming behavior have been tested.

These are separate workloads: prerecorded video narration can tolerate slower generation; live conversation cannot. Do not assume that a model suitable for narration is fast enough for livestream replies.

## Current TRACER capabilities to reuse

- Admin-protected, read-only product feed: `GET /api/admin/ai-live/products`
- The feed only returns published, orderable, in-stock, tracked products that have a published BASE item and Japanese title.
- AI-live comment routing and verified-facts response logic already exist.
- ElevenLabs preview exists as an explicitly triggered, paid test path.

Do not send supplier IDs, supplier costs, shipping costs, margin, customer/order information, or secrets to either local media worker.

## Local machine fit

The currently reported Windows machine has 15.7 GB RAM and Intel Iris Xe integrated graphics with 1 GB reported VRAM.

- MoneyPrinterTurbo: start with one 30–45 second 9:16 video, not batch mode. Expect slower rendering.
- VoiceStudio: the app can run without an NVIDIA GPU, but CPU generation will be slower and the integrated Intel GPU should not be assumed to accelerate its AI engines. Start with a small/lightweight Japanese-capable TTS engine and a short test phrase. Check the selected engine's RAM, disk and model-license requirements before downloading it.
- Do not run large video rendering and voice generation concurrently on this machine until memory use and stability have been measured.

## Install on Windows

### MoneyPrinterTurbo

Requirements: Python 3.11 or later. This repository includes:

```powershell
powershell -ExecutionPolicy Bypass -File .\\scripts\\setup-moneyprinterturbo.ps1
```

The script creates an isolated environment under `%LOCALAPPDATA%\\TRACER\\MoneyPrinterTurbo`, installs the official `mpt` package, and starts the Web UI on `http://127.0.0.1:8503`. It does not install into the TRACER Python environment, alter TRACER dependencies, or configure any API keys.

Official upstream: https://github.com/harry0703/MoneyPrinterTurbo

### VoiceStudio

Install the official Windows desktop app from https://voicestudio.sh/ or run its official PowerShell installer in a normal (non-admin) PowerShell window:

```powershell
irm https://voicestudio.sh/install.ps1 | iex
```

Use the current Windows x64 installer for this Intel/AMD PC. On first launch, allow the app to finish its managed backend setup. Choose a lightweight Japanese-capable TTS engine in the model catalogue; model availability, Japanese quality, hardware requirements and commercial terms vary by engine.

When VoiceStudio is running, its local desktop API is available at `http://localhost:3900`. The OpenAI-compatible speech endpoint is `POST /v1/audio/speech`. For a local smoke test, the documented base URL is `http://localhost:3900/v1` and the local API key can be any non-empty string unless remote access is enabled. Keep this service bound to loopback; do not expose port 3900 publicly or route it through a public TRACER endpoint.

Official docs:
- https://voicestudio.sh/docs/quickstart
- https://voicestudio.sh/docs/local-api

## First audio acceptance test

1. Launch VoiceStudio and confirm its local health endpoint responds at `http://localhost:3900/health`.
2. Select a small Japanese-capable TTS engine and generate a short Japanese sample (10–20 seconds).
3. Measure generation time, audio duration, peak memory use, pronunciation quality, stability across three repeated runs, and whether the result is suitable for the intended character.
4. Check the exact engine/model license for commercial use. The VoiceStudio application license does not replace the individual model's license. Use only voice samples for which the user has appropriate rights and consent.
5. Compare the same script against the existing ElevenLabs preview path. Do not incur paid generation unless explicitly requested.

## First video acceptance test

1. Configure only the required LLM and footage providers in the local MoneyPrinterTurbo UI. Do not paste credentials into TRACER or GitHub.
2. Use a reviewed VoiceStudio audio file as the narration track where the local MoneyPrinterTurbo workflow supports it; otherwise add the audio in a separate local editing step.
3. Create one vertical 9:16 Japanese product explainer using a product already present in the read-only TRACER feed.
4. Verify product title, selling price, shipping statement, stock statement, and destination URL against the current TRACER feed before publishing.
5. Review footage rights, music rights, voice/model commercial terms, captions, pronunciation, and factual accuracy.
6. Save the result locally and manually review it. No automatic posting or livestreaming is enabled by this integration.

## Integration boundary / next implementation

The product feed is read-only and protected by TRACER automation authentication. Both media tools run on the user's PC. A safe bridge must be added only after each local API contract is inspected:

- VoiceStudio: `http://127.0.0.1:3900` (local desktop API; see its OpenAPI document and local API reference).
- MoneyPrinterTurbo: `http://127.0.0.1:8080/docs` after its local API service is started.

A safe bridge should:
- export a minimized product brief from TRACER (public title, approved description, selling price, in-stock flag, public BASE URL);
- send only approved script text to the local VoiceStudio endpoint and keep generated audio on the local machine;
- create a draft video job on the local MoneyPrinterTurbo worker and pass the local audio asset through a supported import path;
- return job status and local output path;
- require human approval before posting;
- never expose either local worker to the public internet or place TRACER admin tokens in browser storage.

Do not use either worker to create or modify listings, orders, inventory, procurement, or prices. Do not enable unattended posting until platform permissions and account eligibility are verified. Do not claim real-time AI LIVE is ready until end-to-end response latency, streaming audio, interruption handling and sustained stability have been measured.

## Upstream references

- MoneyPrinterTurbo: https://github.com/harry0703/MoneyPrinterTurbo
- MoneyPrinterTurbo API docs: http://127.0.0.1:8080/docs after the local API service is started
- VoiceStudio: https://github.com/debpalash/VoiceStudio
- VoiceStudio Windows install: https://voicestudio.sh/install.ps1
- VoiceStudio local API quickstart: https://voicestudio.sh/docs/quickstart
