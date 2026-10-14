# Shopify Collective supplier ingestion into TRACER

TRACER reads only products that were imported into the connected retailer Shopify store through Shopify Collective and then explicitly approved for review by adding the local `tracer-collective-approved` tag. The adapter also requires Shopify's `Shopify Collective` tag and the supplier-name tag that Collective adds to imported products. It does not scrape unrelated storefronts.

## Required local verification before a product becomes a candidate

Shopify documents that supplier tags and metafields are not imported from the supplier's store, so TRACER must not expect the upstream supplier's custom metadata to magically appear in the retailer store. The adapter uses the retailer store's Shopify product/variant IDs as local lookup keys and the imported variant SKU as a cross-store identifier.

For every variant, add these verified metafields in namespace `tracer` after confirming the supplier quote:
- `unit_cost`: non-negative supplier cost in the declared currency
- `shipping_cost`: non-negative shipping cost, confirmed for Japan and the relevant quantity
- `currency`: currency code for both amounts

The SKU must be present. Missing or ambiguous cost/shipping/identity data is rejected; values are never defaulted to zero. The adapter reads current retailer-side Collective inventory, which is supplier-managed and synced by Shopify. Inventory alone does not establish a valid cost or shipping quote.

## Safety boundary

Catalog discovery is enabled, but the adapter always reports `orderable: false`; supplier-side order creation, payment, order status and tracking are disabled here. Shopify Collective can route eligible Shopify orders automatically when its own retailer/supplier connection and payments are configured, but that does not prove BASE or NEWFIND orders are routed through Collective. Those channels require a separately verified fulfillment bridge and idempotent order handling before live sales.

Configure `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, and `SHOPIFY_API_VERSION` in the server environment. Missing credentials fail closed.
