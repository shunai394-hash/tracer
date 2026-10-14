# Shopify Collective supplier ingestion into TRACER

TRACER reads products already imported into the connected retailer store through Shopify Collective. Only products with Shopify's `Shopify Collective` tag and TRACER's local `tracer-collective-approved` tag are considered. Supplier connections and product imports are managed in the Collective app; TRACER does not scrape unrelated storefronts.

## Required candidate evidence

- The variant must have a SKU.
- Shopify Collective's synced supplier cost is read from the Shopify inventory item's `unitCost` field.
- Add `tracer.shipping_cost` after verifying Japan shipping for the relevant quantity.
- Add `tracer.shipping_currency` (or `tracer.currency`) and ensure it exactly matches the synced supplier cost currency.
- Supplier identity must be verified from the Collective supplier connection / vendor evidence before adding the local approval tag.

Missing cost, shipping, SKU, supplier identity, or matching currency is rejected. Values are never defaulted to zero. Inventory is supplier-managed and synced by Shopify; inventory alone is not proof that shipping is available.

## Safety boundary

Catalog discovery is enabled, but the adapter always reports `orderable: false`; supplier order creation, payment, status, and tracking remain disabled in this adapter. Shopify Collective may route eligible Shopify orders through its own checkout and fulfillment workflow, but that does not prove BASE or NEWFIND orders are routed through Collective. Cross-channel fulfillment needs a separately verified bridge and idempotent order handling.

Configure `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, and `SHOPIFY_API_VERSION` in the server environment. Missing credentials fail closed.
