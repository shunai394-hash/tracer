# TRACER production blocker snapshot

Observed at 2026-10-11 via read-only Supabase SQL against project lysavahpadzrhpounjgi.
This is a snapshot, not a live guarantee. No production rows were modified.

## Listing blockers (767 shop_listings)

| pipeline_reason | Rows | Existing Shopify product ID | Existing BASE item ID |
|---|---:|---:|---:|
| supplier_identity_unlinked | 661 | 608 | 540 |
| supply_gate_missing | 98 | 0 | 0 |
| japanese_title_required | 5 | 5 | 0 |
| japanese_catalog_copy_invalid | 3 | 1 | 0 |

All 767 rows were unpublished and blocked at the time of the baseline query. Existing channel IDs must be preserved, but must not override identity or supply gates.

## Current listing evidence

| Evidence field | Rows meeting condition |
|---|---:|
| Supplier listing linked | 669 |
| Supplier product ID present | 669 |
| Supplier variant ID present | 669 |
| Identity method present | 669 |
| Inventory greater than zero | 654 |
| orderable = true | 8 |
| tracking_available = true | 669 |
| Positive selling price | 767 |
| HTTP(S) image URL | 691 |

The very low orderable count (8 of 767) is a separate bottleneck from identity. A record having a supplier product/variant ID or tracking flag does not prove it is currently orderable.

## Supplier candidate reality

- 57,063 supplier_listing rows exist, but the large majority are unverified/unknown candidate records.
- The observed CJ group included 551 rows marked verification_status=verified while identity_status=supply_discovered. Verification that a supplier listing exists is not proof it matches a marketplace demand product.
- Another 191 CJ rows were supply_discovered/retryable. They have product/variant IDs and confirmed positive inventory, but are not canonical identity links.
- The internal catalog evidence path remains empty at the relationship layer: internal_supply_links=0 and marketplace_bestseller_variants=0, despite 60 internal supply products and 60 variants.

## Operational consequence

The immediate path to more publishable products is not to change published flags or count candidate records as products. It is to:
1. produce evidence-backed canonical product/variant links;
2. independently verify price, positive inventory, orderability, shipping and tracking;
3. evaluate Japanese buyer-facing copy, real image and positive contribution margin;
4. run the same fail-closed publication policy before each channel adapter;
5. keep Shopify write/sync disabled until read-only Admin API authentication returns HTTP 200 with the expected shop ID.

This file is a diagnostic record only. It does not authorize bulk relinking, publication, channel writes or supplier orders.
