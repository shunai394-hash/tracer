# TRACER runtime blockers — 2026-10-11

Read-only review of Vercel production runtime error aggregates for the last 24 hours. No token values were read or exposed; no API writes were attempted.

## BASE order API failure

Observed production error group:
- Route: /api/cron/base-orders
- Count: 14
- First: 2026-10-09T21:01:09Z
- Last: 2026-10-10T19:24:38Z
- Error: BASE orders HTTP 400, invalid_request, Japanese description meaning the access token is invalid.

A related failure occurred once on /api/cron/dropship-execution at 2026-10-10T12:30:20Z with the same API error.

## Code path consequence

The current dropship-execution route awaits syncBaseOrdersToTracer(50) before calling runAutonomousOrderControl. If BASE order import throws, control exits to the route-level catch and the supplier-order control step is not reached for that invocation. This is confirmed by the route control flow, not an assumption about whether an external order was placed.

The BASE client in lib/channels/base.ts requires all four OAuth fields:
- BASE_CLIENT_ID
- BASE_CLIENT_SECRET
- BASE_REFRESH_TOKEN
- BASE_REDIRECT_URI

It requests a refresh-token exchange before calling BASE order endpoints. The current runtime error is returned by the orders API as an invalid access token. Do not assume a missing env variable without inspecting only the env-key presence and OAuth refresh response status. Do not print or copy any token or secret value.

## Safe next diagnostic sequence

1. Inspect only whether each of the four BASE OAuth variable names is present in the production environment; never display values.
2. If all are present, run a read-only OAuth refresh diagnostic that records HTTP status, presence of access_token, expiry and safe error code only.
3. If refresh succeeds, perform a minimal read-only BASE order-list request and capture HTTP status plus redacted error category.
4. Keep channel writes and supplier execution disabled until the token path is proven.
5. Separately decouple BASE import failure from other channel workflows only after a deliberate safety review; do not silently let supplier-order execution proceed based on stale or missing order data.

## Shopify status

Shopify Admin API read-only success remains unverified. The successful Vercel preview build is not proof of Shopify API authentication. Require HTTP 200, no GraphQL errors, and the expected shop ID before any Shopify product write path is enabled.
