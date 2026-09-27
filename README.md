# TRACER

世界の商品・ブランド・価格・需要・供給・市場動向を追跡する **AI Commerce Intelligence** の土台です。

現時点の目的は、商品発掘ロジックや無在庫販売の自動化ではなく、本番運用できる接続基盤を置くことです。

```text
GitHub → Next.js → Supabase → Gemini → Bright Data → Vercel → Production
```

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS + ESLint
- Supabase
- Gemini API（サーバー側 Intelligence 層）
- Bright Data / Bright Data MCP（外部世界データ。MCP client として利用）
- Vercel

## Local setup

```powershell
npm install
copy .env.example .env.local
npm run dev
```

`.env.local` に実際の値を入れます。`.env.example` には値を書きません。

## Environment variables

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | anon key only |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | never use in Client Components |
| `GEMINI_API_KEY` | server only | Gemini REST via `lib/ai/gemini` |
| `GEMINI_MODEL` | server only | optional, defaults to `gemini-2.5-flash` |
| `BRIGHTDATA_API_TOKEN` | server only | Bright Data API |
| `BRIGHTDATA_ZONE` | server only | optional zone |
| `BRIGHTDATA_MCP_URL` | server only | external MCP endpoint |
| `BASE_ACCESS_TOKEN` | server only | BASE API OAuth access token |
| `BASE_API_URL` | server only | optional, defaults to `https://api.thebase.in/1` |

外部 API はブラウザから直接呼びません。Route Handler と server module からのみ呼びます。

## Data model

`lib/domain/types.ts` に、Product / Brand / Source / Observation / PriceObservation / MarketSignal / Discovery を定義しています。

商品そのものと、「いつ・どこから観測したか」は分けます。この段階では大量の DB migration は作りません。

## Scripts

```powershell
npm run lint
npx tsc --noEmit
npm run build
```


## Production market-to-publication pipeline

TRACER separates **market observation** from **sourcing decisions**:

```text
Amazon / Rakuten / Yahoo
        ↓
market observation
        ↓
verified marketplace identifiers
        ↓
CJ supplier search
        ↓
exact identity / variant confirmation
        ↓
CN-stocked variant
        ↓
CJ CN → JP freight quote
        ↓
contribution-profit gate
        ↓
shop_listings.published = true
        ↓
/shop
        ↓
BASE publication
        ↓
NEWFIND product_candidate
```

The production batch endpoint is:

```text
GET /api/cron/market-sourcing
```

When `CRON_SECRET` is configured, the request must contain:

```text
Authorization: Bearer <CRON_SECRET>
```

Vercel Cron is configured in `vercel.json` and runs the bounded sourcing batch once per day. The batch is intentionally bounded because CJ product search, detail, variant, and freight APIs are rate-limited and consume API points.

### Publication gates

A product is not published unless the current sourcing evidence supports:

- marketplace rank/title/selling price
- supplier identity confirmation
- concrete CJ variant
- supplier cost
- current CN → JP freight quote when available
- tracking/API capability required by the current sales-test gate
- positive contribution profit

A failed sourcing run **does not unpublish existing products**.

### Important environment variables

Production must have the server-side Supabase variables, `CJ_API_KEY`, `CRON_SECRET`, the BASE API access token, and the NEWFIND bridge variables configured before the full pipeline can operate.

Published sales-test listings are also sent to BASE when `BASE_ACCESS_TOKEN` is configured. The BASE item ID is stored on the TRACER listing so repeated cron runs do not create duplicates. The BASE API supports product creation and image registration through its `write_items` scope. citeturn1search1turn2search0

Real CJ supplier ordering remains separately guarded by `CJ_LIVE_ORDERING=0` and human approval. Publishing a sales-test listing does not place a supplier order.

### Manual investigation

For a specific batch, use the sourcing decision endpoint with authenticated access. The endpoint supports a candidate offset so later verified candidates can be investigated without changing the observation layer.
