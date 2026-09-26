# TRACER Chrome Extension

Initial flow:

Amazon product page
→ Capture & Send
→ TRACER /api/extension/product
→ EC-Pulse normalization/persistence
→ TRACER product/observation storage

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select this `extension/` directory.
5. Open an Amazon product page and click the TRACER extension.

## Configuration

The popup stores:

- `apiBase`: TRACER deployment URL.
- `extensionKey`: optional server-side ingestion key.

Do not put EC-Pulse API keys, Supabase service-role keys, or other backend secrets into the extension.

## Scope

This first version targets Amazon.com and Amazon.co.jp product pages. Identifier enrichment remains server-side through TRACER/EC-Pulse.
