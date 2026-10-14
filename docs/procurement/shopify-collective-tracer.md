# Shopify Collective supplier ingestion into TRACER

TRACER reads only products that were imported into the connected retailer Shopify store through Shopify Collective and then explicitly approved for review by adding the local `tracer-collective-approved` tag. The adapter also requires Shopify's `Shopify Collective` tag and the supplier-name tag that Collective adds to imported products. It does not scrape unrelated storefronts.

## Required local verification before a product becomes a candidate

Shopify documents that supplier tags and metafields are not imported from the supplier's store, so TRACER must not expect the upstream supplier's custom metadata to magically appear in the retailer store. The adapter uses the retailer store's Shopify product/variant IDs as local lookup keys and the imported variant SKU as a cross-store identifier.

For every variant, Shopify Collective syncs supplier cost into the Shopify inventory item cost field. TRACER reads that value directly; the SKU must be present. Add these verified metafields in namespace `tracer` after confirming the supplier shipping quote for Japan and the relevant quantity:
- `shipping_cost`: non-negative shipping amount
- `shipping_currency` (or `currency`): currency code that must match the synced supplier cost currency

Missing cost, shipping, SKU, or matching currency is rejected; values are never defaulted to zero. The adapter reads current retailer-side Collective inventory, which is supplier-managed and synced by Shopify. Inventory alone does not establish a valid shipping quote.

## Safety boundary

Catalog discovery is enabled, but the adapter always reports `orderable: false`; supplier-side order creation, payment, order status and tracking are disabled here. Shopify Collective can route eligible Shopify orders automatically when its own retailer/supplier connection and payments are configured, but that does not prove BASE or NEWFIND orders are routed through Collective. Those channels require a separately verified fulfillment bridge and idempotent order handling before live sales.

Configure `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, and `SHOPIFY_API_VERSION` in the server environment. Missing credentials fail closed.
