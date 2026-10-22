# Parent / Variant Storefront Migration Plan

## Purpose

Make TRACER's canonical parent product and child variants the source of truth, while avoiding destructive deduplication of existing BASE and Shopify listings.

This document is a migration plan only. It does not publish, unpublish, merge, or delete storefront products.

## Verified current behavior

- `lib/commerce/publish.ts` iterates `commerce_variants` as publication candidates.
- For a new BASE candidate, it calls `createBaseItem` with one title, identifier, detail, price, and stock. The current wrapper in `lib/channels/base.ts` posts these fields to `/items/add`; it does not expose a variant/option collection.
- For a new Shopify candidate, `createShopifyProduct` calls `productCreate`, then updates the one default variant's SKU and price. The current sync path derives a distinct handle from the parent source key plus the variant UUID, which permits each child variant to become a separate Shopify product.
- `channel_listings` records a mapping for each canonical `variant_id` to its external product and variant IDs. These mappings are order/procurement-sensitive and must not be discarded during migration.

## Read-only production snapshot

A read-only aggregate query grouped listings by canonical `commerce_products.source_key` and channel:

| Measure | BASE | Shopify |
| --- | ---: | ---: |
| Parent groups | 384 | 384 |
| Parent groups with multiple canonical variants | 244 | 244 |
| Multi-variant groups split across multiple published external product IDs | 171 | 177 |
| Extra published external product IDs (candidate count, not deletion count) | 380 | 415 |
| Multi-variant groups already sharing one published external product ID | 48 | 43 |

These numbers describe reconciliation candidates, not safe deletions. Recompute immediately before any production migration.

## Required implementation

### Shopify

1. Change publication from variant-by-variant product creation to parent-aware reconciliation keyed by the canonical `source_key`.
2. Use one stable product handle derived from the canonical parent, not a child variant UUID.
3. For each child variant, preserve a stable SKU and persist its actual Shopify Product ID and ProductVariant ID into that variant's existing `channel_listings` row.
4. Add/update variants idempotently. Never create a second product merely because a child variant lacks its mapping.
5. Preserve variant-specific price, inventory, supplier identity, Japan shipping, tracking, and profit checks.
6. Before migration, reconcile existing external products by exact SKU / persisted IDs. If one SKU maps ambiguously, stop that parent group and emit an actionable error; do not guess.
7. Do not automatically delete or archive split products in the first migration. Generate a report of old product IDs, target product ID, variant SKUs, order references, and required manual actions.

### BASE

1. The current wrapper only exposes a single BASE item with identifier, price, stock, title and detail; it does not implement variants.
2. Verify the currently supported BASE API and actual shop capabilities before choosing a grouping strategy.
3. If BASE cannot represent variants under one item through its supported API, keep distinct sellable BASE items but group them under the same TRACER parent identity in the internal catalog. Do not pretend BASE product counts can equal Shopify product counts if the channel's data model cannot represent the same structure.
4. Keep each BASE item ID and identifier/SKU mapping intact for order-line reconciliation.

## Migration safety gates

- Dry-run output must be complete; incomplete snapshots fail closed.
- Every proposed mapping must resolve to exactly one canonical parent, one canonical variant, and one external listing identity.
- Preserve `channel_listings` rows and external IDs until order history and all references have been reconciled.
- Do not delete, unpublish, or overwrite customer-facing listings as part of an automatic first pass.
- Verify order matching, supplier procurement, stock updates, price updates, and rollback behavior before rollout.
- Roll out to one test parent with at least two variants, then a small allowlisted batch, before any broader migration.
- Compare counts by parent and variant, not only raw product counts.
- Keep existing cron schedules and unrelated publication paths unchanged.

## Acceptance criteria

- Re-running sync is idempotent: it does not create extra products or variants.
- Each Shopify canonical parent has one external product, with all eligible child variants mapped to actual Shopify variant IDs.
- BASE behavior matches the verified BASE API capability; any unavoidable difference is reported explicitly.
- No listing has a missing or ambiguous variant mapping.
- Existing orders still resolve to the same sellable SKU / external line identity.
- The dry-run report accounts for every old external product ID and states whether it can be retained, remapped, or requires manual review.
- Tests cover retries after partial API success, duplicate SKU ambiguity, pagination incompleteness, and rollback.
