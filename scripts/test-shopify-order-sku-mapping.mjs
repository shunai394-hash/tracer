import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getOrderSkuLookup,
  resolveShopifyOrderSkus,
  tracerSkuForListing,
} from "../lib/shopify/order-sku-mapping.ts";

test("uses the same stable listing SKU across channels and resolves legacy supplier SKUs", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: "variant-42", supplier_product_id: "product-7" };
  const sku = tracerSkuForListing(listing);
  assert.equal(sku, `TRC-${listing.id}`);
  assert.deepEqual(getOrderSkuLookup([sku]).legacyListingIds, [listing.id]);
  assert.equal(resolveShopifyOrderSkus([sku], [listing]).ok, true);
  assert.equal(resolveShopifyOrderSkus(["TRC-variant-42"], [listing]).ok, true, "legacy variant-based SKUs remain order-resolvable");
  assert.equal(resolveShopifyOrderSkus(["TRC-product-7"], [listing]).ok, true, "legacy product-based SKUs remain order-resolvable");
});

test("generated shared SKU always uses the listing ID when supplier IDs are absent", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: null, supplier_product_id: null };
  const generated = tracerSkuForListing(listing);
  assert.equal(generated, `TRC-${listing.id}`);
  assert.deepEqual(getOrderSkuLookup([generated]).legacyListingIds, [listing.id]);
  assert.equal(resolveShopifyOrderSkus([generated], [listing]).ok, true);
  assert.equal(resolveShopifyOrderSkus([listing.id], [listing]).ok, true);
});

test("fails closed for missing and ambiguous exact SKU mappings", () => {
  assert.deepEqual(
    resolveShopifyOrderSkus(["TRC-no-match"], []),
    { ok: false, reason: "listing_mapping_missing", sku: "TRC-no-match" },
  );
  const a = { id: "a", supplier_variant_id: "same-variant", supplier_product_id: null };
  const b = { id: "b", supplier_variant_id: "same-variant", supplier_product_id: null };
  assert.deepEqual(
    resolveShopifyOrderSkus(["TRC-same-variant"], [a, b]),
    { ok: false, reason: "listing_mapping_ambiguous", sku: "TRC-same-variant" },
  );
});

const sync = readFileSync("lib/shopify/sync-published-listings.ts", "utf8");
test("Shopify product sync uses the shared BASE listing identifier", () => {
  assert.match(sync, /return `TRC-\$\{listing\.id\}`/);
  assert.doesNotMatch(sync, /const source = listing\.supplier_variant_id/);
});

const webhook = readFileSync("app/api/webhooks/shopify/orders/route.ts", "utf8");
test("Shopify webhook writes the deployed order schema and repairs partial item imports", () => {
  assert.match(webhook, /shopify_order_name:/, "use the existing shopify_order_name column");
  assert.doesNotMatch(webhook, /shopify_order_number:/, "do not write a column absent from the deployed schema");
  assert.match(webhook, /shopify_line_item_id_missing/, "require stable line IDs for idempotent retries");
  assert.match(webhook, /incomingLineIds\.every\(\(id\) => existingLineItemIds\.has\(id\)\)/,
    "fully imported webhook retries must short-circuit");
  assert.match(webhook, /existing_order_items_legacy_id_missing/,
    "do not guess mappings for legacy items without Shopify IDs");
  assert.match(webhook, /shop_order_items_insert_failed:/,
    "surface an item write failure so Shopify retries can repair the order");
});

const admin = readFileSync("lib/shopify/admin.ts", "utf8");
test("Shopify webhook HMAC accepts the configured app client secret when no override exists", () => {
  assert.match(admin, /process\\.env\\.SHOPIFY_WEBHOOK_SECRET\\?\\.trim\\(\\) \\|\\| process\\.env\\.SHOPIFY_CLIENT_SECRET\\?\\.trim\\(\\)/);
});
