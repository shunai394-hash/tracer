# TRACER unified supply-to-channel rebuild

## Objective

Replace the disconnected supplier-investigation, canonical-catalog, sales-test, and channel-publishing flow with one observable pipeline. The goal is real, correctly described products in TRACER, BASE, and Shopify—not merely a larger count of candidate rows.

## Non-negotiable invariants

1. A candidate is not rejected solely because JAN/GTIN/EAN/UPC/MPN/ASIN is absent. Supplier-native product ID, variant ID, product URL, SKU, title/brand, and source evidence must be considered as alternative locators. A locator is not, by itself, proof that two marketplace products are identical.
2. Keep separate states for `discovered`, `located`, `identity_verified`, `economics_verified`, `listing_ready`, and each channel's result. Do not overload one `published` flag to represent all channels.
3. Calculate contribution profit from selling price minus supplier cost, Japan-bound shipping, platform/payment fees, and any known handling/import costs. Unknown costs are unknown, not zero. Store currency and conversion-rate evidence.
4. Catalog identity and supplier-order identity are distinct. A product can be listed when product details and economics are verified; automated ordering additionally requires an exact, current supplier product + variant mapping, stock/orderability, shipping, and tracking/fulfillment evidence.
5. One canonical listing can have independent TRACER, BASE, and Shopify publication results. A failure or missing external ID on one channel must not prevent retries on the others.
6. Japanese storefront copy, a usable image, a valid JPY price, and a positive evidence-backed contribution profit are required before public publication. Never fabricate image, stock, cost, shipping, or supplier IDs.
7. Every stage is idempotent, resumable, rate-limited, and records its input IDs, outcome, rejection reason, evidence timestamp, and retryability.
8. No production bulk publish, deletion, or order placement is part of the rebuild PR. Live actions require explicit gates and post-action reconciliation.

## Target flow

`source discovery -> locator normalization -> canonical product/variant resolution -> supplier offer + shipping verification -> JPY landed-cost/profit calculation -> Japanese listing preparation -> TRACER publish -> BASE sync + Shopify sync independently -> reconciliation -> order gate`

The same candidate record must be able to move forward or be retried from the failed stage; separate cron schedules must not strand it between stages.

## Work sequence

### A. Establish truth
- Snapshot real counts by source, canonical product, supplier offer, and each channel.
- Reconcile the existing BASE/Shopify product IDs to canonical listings; adopt existing valid listings rather than duplicating them.
- Report the exact blocker distribution and source evidence freshness.

### B. Rebuild the pipeline core
- Add pure, unit-tested normalization and eligibility functions.
- Add a stage transition contract and idempotency key.
- Support supplier-native locators and URL-based enrichment without pretending they prove variant identity.
- Calculate landed cost and contribution profit in one shared module.

### C. Make channel publishing independent
- Keep one canonical listing identity and distinct channel sync states/IDs/errors.
- Retry only failed channel writes and reconcile remote state before creating duplicates.
- Require Japanese copy and real product imagery at the shared publication boundary.

### D. Prove end-to-end behavior
- Integration tests for missing identifiers with a valid supplier locator, ambiguous variants, missing/unknown shipping, non-positive profit, translation failure, BASE-only success, Shopify-only success, partial channel failure, retries, and duplicate prevention.
- Run existing tests and production read-only reconciliation.
- Enable small, bounded publication only after tests pass; compare actual remote counts before and after.

## Definition of done

- One candidate can be traced from source URL/ID through cost, shipping, profit, canonical listing, and each channel's external ID.
- Each channel's status is independently observable and retryable.
- No English-heavy or placeholder listing is made public.
- Automatic ordering cannot run without an exact supplier product/variant pair and current fulfillment evidence.
- Counts are derived from actual channel APIs/DB reconciliation, never estimates.
- Build, regression tests, and bounded live verification are recorded in the PR; no claim of completion without that evidence.
