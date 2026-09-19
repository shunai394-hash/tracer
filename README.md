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
