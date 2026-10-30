# TRACER × MoneyPrinterTurbo — local short-video pipeline

## Goal

Use MoneyPrinterTurbo as a **local rendering worker** for TRACER product videos. Keep TRACER as the source of truth for product facts. Keep video rendering off Vercel to avoid serverless execution time and cost.

## Current TRACER capabilities to reuse

- Admin-protected, read-only product feed: `GET /api/admin/ai-live/products`
- The feed only returns published, orderable, in-stock, tracked products that have a published BASE item and Japanese title.
- AI-live comment routing and verified-facts response logic already exist.
- ElevenLabs preview exists as an explicitly triggered, paid test path.

Do not send supplier IDs, supplier costs, shipping costs, margin, customer/order information, or secrets to the video worker.

## Local machine fit

The currently reported Windows machine has 15.7 GB RAM and Intel Iris Xe integrated graphics with 1 GB reported VRAM. MoneyPrinterTurbo's current upstream documentation says a GPU is not required and recommends 16+ GB RAM; cloud LLM/TTS and online footage sources are more practical on this machine than heavy local models. Expect slower video rendering. Start with one 30–45 second 9:16 video, not batch mode.

## Install on Windows

Requirements: Python 3.11 or later. This repository includes:

```powershell
powershell -ExecutionPolicy Bypass -File .\\scripts\\setup-moneyprinterturbo.ps1
```

The script creates an isolated environment under `%LOCALAPPDATA%\\TRACER\\MoneyPrinterTurbo`, installs the official `mpt` package, and starts the Web UI on `http://127.0.0.1:8503`. It does not install into the TRACER Python environment, alter TRACER dependencies, or configure any API keys.

Official upstream: https://github.com/harry0703/MoneyPrinterTurbo

## First video acceptance test

1. Configure only the required LLM and footage providers in the local MoneyPrinterTurbo UI. Do not paste credentials into TRACER or GitHub.
2. Create one vertical 9:16 Japanese product explainer using a product already present in the read-only TRACER feed.
3. Verify product title, selling price, shipping statement, stock statement, and destination URL against the current TRACER feed before publishing.
4. Review footage rights, music rights, voice/model commercial terms, captions, pronunciation, and factual accuracy.
5. Save the result locally and manually review it. No automatic posting or livestreaming is enabled by this integration.

## Integration boundary / next implementation

The current product feed is read-only and protected by TRACER automation authentication. MoneyPrinterTurbo runs on the user's PC. A safe bridge must be added only after the local API contract is inspected at `http://127.0.0.1:8080/docs`:

- export a minimized product brief from TRACER (public title, approved description, selling price, in-stock flag, public BASE URL);
- create a draft video job on the local worker;
- return job status and local output path;
- require human approval before posting;
- never expose the local worker to the public internet or place TRACER admin tokens in browser storage.

Do not use the video worker to create or modify listings, orders, inventory, procurement, or prices. Do not enable unattended posting until platform permissions and account eligibility are verified.

## Upstream references

- Windows and pip install: https://github.com/harry0703/MoneyPrinterTurbo
- Requirements and API docs: http://127.0.0.1:8080/docs after the local API service is started
