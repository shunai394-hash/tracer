# TRACER

世界の商品・ブランド・価格・需要・供給・市場動向を追跡する **AI Commerce Intelligence** の土台です。

目的は、需要発掘 → 仕入先の実在商品・バリエーション確認 → 原価・日本向け送料・手数料込み利益計算 → BASE / Shopify 公開 → NEWFIND 同期 → 注文・仕入発注・追跡番号反映までを、証跡付きでつなぐことです。未確認の工程を成功扱いせず、公開と発注は実際の外部応答で確認します。

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

`.env.local` に実際の値を入れます。.env.example には値を書きません。

## Environment variables

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | anon key only |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | never use in Client Components |
| `GEMINI_API_KEY` | server only | Gemini REST via `lib/ai/gemini` |
| `GEMINI_MODEL` | server only | optional, defaults to `gemini-3.8-flash` (legacy `gemini-2.5-flash` setting falls back to 3.8) |
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

## Production supplier-to-publication pipeline

TRACER is the source of truth. Supplier-native CJ catalog discovery is separate from optional demand research; marketplace titles or rankings cannot create sellable products or establish supplier identity.

```text
CJ supplier catalog
  -> exact CJ product + variant ID
  -> fresh variant stock + price
  -> live Japan shipping quote
  -> Japanese product copy + image validation
  -> landed cost + positive contribution profit
  -> TRACER listing
  -> BASE + Shopify reconciliation
  -> store order import
  -> supplier preflight + order creation
  -> supplier status + tracking sync
```

The scheduled supplier discovery endpoint is `/api/cron/supply-first`. Marketplace sourcing is intentionally **not scheduled and not invoked by production recovery workflows**. Legacy market-observation rows are not procurement or publication evidence. Amazon, Rakuten, Yahoo! Shopping, and Orosy are not supplier sources.

### Publication gates

A product is not published unless the current sourcing evidence supports:

- marketplace rank/title/selling price
- supplier identity confirmation
- concrete CJ variant
- supplier cost
- current CN → JP freight quote when available
- tracking/API capability required by the current sales-test gate
- positive contribution profit

A failed sourcing run **does not unpublish existing products**. A current exact-variant stockout instead makes the listing non-orderable and BASE stock zero; checkout is blocked until a later inventory refresh observes stock again.

### Important environment variables

Production must have the server-side Supabase variables, `CJ_API_KEY`, `CRON_SECRET`, the BASE API access token, and the NEWFIND bridge variables configured before the full pipeline can operate.

Published sales-test listings are also sent to BASE when `BASE_ACCESS_TOKEN` is configured. The BASE item ID is stored on the TRACER listing so repeated cron runs do not create duplicates. BASE does not provide an order webhook, so `/api/cron/base-orders` polls BASE orders and imports them into the same TRACER order/fulfillment pipeline. The BASE API supports product creation and image registration through its `write_items` scope.

Real CJ supplier ordering remains separately guarded by `CJ_LIVE_ORDERING=0`. `CJ_AUTO_ORDERING=1` is a second explicit switch for unattended execution; it must not be enabled until the live CJ create-order contract has been verified in the target account. Publishing a sales-test listing does not place a supplier order.

### Manual investigation

For a specific batch, use the sourcing decision endpoint with authenticated access. The endpoint supports a candidate offset so later verified candidates can be investigated without changing the observation layer.

<!-- production-deploy-retrigger: 2026-10-06 [ops-trigger] -->
<!-- newfind-patrol-repair: bounded-sales-test-publication -->
<!-- supply-first-production-retrigger: 2026-10-02 -->


<!-- operational-cycle: 2026-10-08-publish-cj-now-oidc-fixed -->


<!-- publication-patrol: 2026-10-08 [publish-cj-now] -->
<!-- publication-patrol: 2026-10-08 [publish-cj-now][jp-quality-gate] -->

<!-- publication patrol trigger 2026-10-08T16:33:24.527Z -->

<!-- publish-cj-now-retrigger: 2026-10-09 -->

<!-- 1000-product patrol 2026-10-08T16:42:54.142Z [publish-cj-now] -->
