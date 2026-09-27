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


## Store / policy checklist

Before publishing to the Chrome Web Store:

- Complete the Store listing and Privacy tabs in the Chrome Web Store Developer Dashboard.
- Provide the deployed TRACER privacy policy URL.
- Describe the product data fields collected by the extension and their purpose.
- Keep permissions limited to the functionality actually used.
- Do not add browsing-history, cookies, bookmarks, password, payment, or unrelated site permissions.
- Review each supported marketplace's terms and automated-access rules before expanding beyond the current Amazon scope.
- Keep backend credentials server-side; the extension must never contain EC-Pulse API keys or database service-role credentials.
- The extension icon set includes 16px, 48px, and 128px PNG assets required for normal Chrome extension presentation.
