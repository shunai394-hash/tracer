# Shopify Collective supplier ingestion into TRACER

This integration intentionally reads only products in the connected Shopify retailer store that have the `tracer-collective-approved` tag and supplier identity metadata. A supplier's product must first be imported/authorized through Shopify Collective; TRACER does not scrape arbitrary storefronts or assume resale permission.

## Required product metafields (namespace `tracer`)

Product:
- `supplier_product_id`: upstream supplier product ID (evidence of source identity)

Each variant:
- `supplier_variant_id`: upstream supplier variant ID
- `unit_cost`: supplier cost as a non-negative numeric amount
- `shipping_cost`: shipping amount as a non-negative numeric amount
- `currency`: currency code used for cost and shipping

Only variants with supplier variant identity, explicit cost, and explicit shipping are returned. Missing values are not defaulted to zero. The adapter reads current Shopify variant inventory at discovery time.

## Safety boundary

Catalog and inventory discovery are enabled; supplier-side order creation, payment, order status, and tracking remain disabled until the actual supplier order API and payment flow are implemented and verified. `orderable` remains false so downstream publication gates must not treat an imported product as ready to sell. Do not manually override this gate to publish.

Required app scopes include product read access. Configure `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, and `SHOPIFY_API_VERSION` in the server environment. The integration will fail closed when credentials are missing.
