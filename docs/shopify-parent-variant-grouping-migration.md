# Shopify parent-product / variant grouping migration

## Status

Design and safety contract only. No storefront records are changed by this document. Do not merge a publisher rewrite until the dry-run report and tests described below pass.

## Problem confirmed in the current publisher

- `lib/commerce/publish.ts` processes one `commerce_variants` candidate at a time.
- The Shopify create path calls `createShopifyProduct(...)` for that candidate when no existing product/variant mapping can be recovered.
- The create helper creates a product with one initial sellable variant. As a result, CJ style variants that belong to one parent can become separate Shopify product pages.
- BASE currently represents each sellable unit as a separate item; keep that mapping unless BASE's supported API proves a native variant model exists.

## Non-negotiable identity invariants

1. `commerce_products.source_key` identifies the supplier parent; for CJ this is the stable parent key (for example, `cj:<supplier_product_id>`).
2. Each `commerce_variants.id` and `source_variant_key` remains stable. Never merge or regenerate internal variant UUIDs to reduce page counts.
3. Every internal variant retains its own `supplier_offers.supplier_variant_id`, SKU, price, stock, and channel mapping.
4. Shopify's parent product ID is shared by all grouped variants; Shopify's variant ID is unique per internal variant. Persist both IDs for every mapping.
5. BASE external item IDs remain per sellable variant; a BASE item ID must not be mistaken for a Shopify parent ID.
6. A same-title or same-image match is not sufficient evidence for grouping or deletion.
7. Do not delete, unpublish, or overwrite existing channel records during a dry run. Do not auto-order from CJ as part of migration.

## Implementation sequence

### Phase A — read-only grouping manifest

Build a deterministic manifest grouped by `commerce_products.id` / `source_key`, not by title. Include for each candidate:
- internal product ID and source key;
- internal variant ID and source variant key;
- supplier code, supplier parent ID, supplier variant ID;
- current Shopify product ID and variant ID;
- current BASE item ID;
- SKU, selling price, available stock, publication state;
- proposed Shopify parent group and any blocking reason.

Fail closed when a parent key, supplier variant ID, SKU, price, or mapping is missing or ambiguous. Report conflicts; do not guess.

### Phase B — Shopify variant mutation adapter

Add a dedicated adapter that can create/update a Shopify parent product and its variants. It must:
- create the parent once per canonical `commerce_products` row;
- add/update each variant using a stable internal-variant-to-Shopify-variant mapping;
- set SKU, price, inventory item, and image/media without replacing unrelated variants;
- read back the persisted product and all variants before reporting success;
- be idempotent on rerun and avoid replaying a mutation after an ambiguous 5xx;
- preserve current SEO and publication checks;
- keep inventory synchronization attached to the correct Shopify variant ID.

Do not change the existing one-variant publishing path until this adapter has isolated tests.

### Phase C — dry-run and compatibility checks

For a sample parent with multiple styles (including a parent currently represented by 13 separate Shopify products):
- assert one proposed Shopify parent and N distinct variants;
- assert every internal variant maps to exactly one supplier variant and one Shopify variant;
- assert no duplicate SKU or supplier variant mapping;
- compare pre/post prices and stock by internal variant ID;
- produce an explicit old-product-ID -> target-product-ID/variant-ID migration table;
- flag orders, fulfillment records, or channel mappings that reference an old product/variant ID.

No automatic cleanup in this phase.

### Phase D — controlled migration

Only after a reviewed dry-run:
1. Back up the mapping manifest.
2. Migrate one low-risk parent in a non-production/test store first.
3. Verify storefront variant selection, cart line-item SKU, order line-item variant ID, inventory deduction, refund/fulfillment compatibility, and webhook reconciliation.
4. Migrate a small production cohort with explicit rollback mapping.
5. Retire old product pages only after references and order history are proven safe; otherwise leave them unpublished only with a reversible, audited operation.

## Acceptance criteria

- Parent page count is reduced only where canonical parent identity proves variants belong together.
- No internal variant, supplier variant ID, SKU, price, stock, order reference, or BASE item mapping is lost.
- Shopify readback matches the manifest for 100% of migrated variants.
- Re-running the publisher creates no extra products or variants.
- The normal storefront never exposes audit terminology or fabricated imagery.
- CJ live ordering remains disabled until a real paid order -> supplier order -> tracking -> Shopify fulfillment test passes.

## Current known limitation

The current publisher's `Candidate` is per variant and its Shopify create branch creates a product per candidate. This document defines the safe migration contract; it is not evidence that the new variant adapter or a live migration has been implemented.
