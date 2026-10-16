# TRACER Clean Commerce Core

A canonical model for TRACER, BASE, Shopify and supplier fulfillment. Legacy tables remain empty and are not used by this core.

## Flow
1. Import a product and supplier-native variant IDs.
2. Upsert canonical product, variant and supplier offer using stable unique keys.
3. Calculate JPY selling price from cost, shipping, FX, channel fees and target margin.
4. Track BASE and Shopify listing states independently from the same canonical variant and price.
5. Ingest paid orders idempotently by channel + external order ID and line ID.
6. Create one procurement record per order line; supplier submission and tracking updates are retryable steps.
7. Record operations with idempotency keys in commerce_events.

Catalog publication and fulfillment are separate. Before a supplier order is submitted, re-check current inventory, Japan shipping, current cost and supplier API readiness. Never submit a paid order twice.

Apply supabase/migrations/20261016170000_clean_commerce_core.sql with Supabase migrations. This migration is additive and deliberately does not drop legacy tables or scheduled jobs.

Keep Vercel secrets for Supabase, CJ, BASE and Shopify. Never put credentials in source control. Run read-only auth checks before any external write operations.
