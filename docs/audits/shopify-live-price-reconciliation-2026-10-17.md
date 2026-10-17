# Shopify live price reconciliation — 2026-10-17

## Scope and method
- Store: `ieufrg-tb.myshopify.com` (JPY, JST).
- Read-only live catalog sweep: 2,292 Shopify products across all result pages.
- Compared the 570 `channel_listings` rows marked `published` to the live Shopify Product GID, Variant GID, SKU, and price; each listing was matched by its external product and variant IDs.
- The live scan found all 570 published listing mappings; exact external SKU match: 570/570; missing product/variant mappings: 0.
- Live Shopify price vs latest `commerce_prices`: 0 mismatches out of 570.
- Live Shopify price vs `channel_listings.selling_price`: 0 mismatches out of 570.
- DB snapshot latest canonical price vs stored listing price: 0 mismatches out of 570.
- Product status count from live sweep: ACTIVE 678, DRAFT 921, ARCHIVED 693 (2,292 total). These are all products, not only the 570 published-listing mappings.

## Important limitation
The reported sync-log discrepancy count of 145 is a separate sync-record metric. This audit confirms current live Shopify prices against the current canonical DB rows; it does not prove that the 145 historical sync-log records have been reconciled or cleared. BASE external live prices were not fetched in this Shopify-only scan.

## Row-level evidence
See `shopify-live-price-reconciliation-2026-10-17.csv`. The `live_shopify_price_jpy` column is the live price observed during the sweep; the live scan returned no differences from the canonical price or stored listing price for all 570 mapped variants.
