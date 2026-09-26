# TRACER Chrome Extension

Amazon product capture MVP.

## Flow

Amazon product page
→ Extension popup
→ `POST /api/extension/product`
→ identifier reconciliation
→ TRACER DB
→ EC-Pulse product lookup/persistence
→ popup result

## Build

From the TRACER root:

```powershell
npx tsc -p extension/tsconfig.json
```

The generated JavaScript is written to `extension/dist`.

## Load in Chrome

1. Build the extension.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked**.
5. Select `TRACER/extension`.
6. Open an Amazon product page.
7. Open the TRACER extension popup.
8. Set TRACER URL and Extension Key if needed.
9. Click **Amazon商品をTRACERへ送信**.

## Server configuration

Set:

```
TRACER_EXTENSION_API_KEY=your-private-extension-key
```

The extension sends this value in `X-TRACER-EXTENSION-KEY`.

For local development the default API URL is `http://localhost:3000`.
