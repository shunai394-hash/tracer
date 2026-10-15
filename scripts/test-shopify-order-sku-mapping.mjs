import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getOrderSkuLookup,
  resolveShopifyOrderSkus,
  tracerSkuForListing,
} from "../lib/shopify/order-sku-mapping.ts";

test("resolves generated TRC SKU by supplier variant ID", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: "variant-42", supplier_product_id: "product-7" };
  const sku = tracerSkuForListing(listing);
  assert.equal(sku, "TRC-variant-42");
  assert.deepEqual(getOrderSkuLookup([sku]).supplierSources, ["variant-42"]);
  const resolved = resolveShopifyOrderSkus([sku], [listing]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.bySku.get(sku)?.id, listing.id);
});

test("resolves legacy CJ SKU by exact supplier variant ID", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: "variant-42", supplier_product_id: "product-7" };
  assert.deepEqual(getOrderSkuLookup(["CJ-variant-42"]).supplierSources, ["variant-42"]);
  const resolved = resolveShopifyOrderSkus(["CJ-variant-42"], [listing]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.bySku.get("CJ-variant-42")?.id, listing.id);
  assert.equal(resolveShopifyOrderSkus(["CJ-product-7"], [listing]).ok, false,
    "CJ SKU must not silently map a product ID when a variant ID is required");
});

test("resolves SKU fallback to supplier product ID", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: null, supplier_product_id: "product-7" };
  const sku = tracerSkuForListing(listing);
  assert.equal(sku, "TRC-product-7");
  const resolved = resolveShopifyOrderSkus([sku], [listing]);
  assert.equal(resolved.ok, true);
});

test("resolves SKU fallback to listing ID and supports legacy raw listing ID", () => {
  const listing = { id: "11111111-1111-4111-8111-111111111111", supplier_variant_id: null, supplier_product_id: null };
  const generated = tracerSkuForListing(listing);
  assert.deepEqual(getOrderSkuLookup([generated]).legacyListingIds, [listing.id]);
  assert.equal(resolveShopifyOrderSkus([generated], [listing]).ok, true);
  assert.equal(resolveShopifyOrderSkus([listing.id], [listing]).ok, true);
});

test("resolves multiple distinct order lines and trims webhook SKU whitespace", () => {
  const a = { id: "listing-a", supplier_variant_id: "variant-a", supplier_product_id: "product-a" };
  const b = { id: "listing-b", supplier_variant_id: "variant-b", supplier_product_id: "product-b" };
  const resolved = resolveShopifyOrderSkus([" TRC-variant-a ", "CJ-variant-b"], [a, b]);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.bySku.get("TRC-variant-a")?.id, "listing-a");
    assert.equal(resolved.bySku.get("CJ-variant-b")?.id, "listing-b");
  }
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
