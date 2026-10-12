import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveShopifyVariantBySku } from "../lib/shopify/variant-match.ts";

const unique = resolveShopifyVariantBySku({
  targetSku: "TRC-supplier-variant-7",
  variants: [
    { id: "gid://shopify/ProductVariant/1", sku: "OTHER" },
    { id: "gid://shopify/ProductVariant/7", sku: "TRC-supplier-variant-7" },
  ],
});
assert.equal(unique.ok, true);
if (unique.ok) assert.equal(unique.variant.id, "gid://shopify/ProductVariant/7");

assert.deepEqual(resolveShopifyVariantBySku({
  targetSku: "TRC-target",
  variants: [{ id: "1", sku: "OTHER" }],
}), { ok: false, variant: null, reason: "target_sku_missing" });

assert.deepEqual(resolveShopifyVariantBySku({
  targetSku: "TRC-target",
  variants: [{ id: "1", sku: "TRC-target" }, { id: "2", sku: "TRC-target" }],
}), { ok: false, variant: null, reason: "target_sku_duplicate" });

assert.deepEqual(resolveShopifyVariantBySku({
  targetSku: "TRC-target",
  hasNextPage: true,
  variants: [{ id: "1", sku: "TRC-target" }],
}), { ok: false, variant: null, reason: "variant_list_incomplete" });

const source = readFileSync(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
assert.match(source, /resolveShopifyVariantBySku/);
assert.match(source, /supplierVariantId/);
assert.match(source, /shopifyVariantId/);
assert.doesNotMatch(source, /variantId:\s*existing\.variants\.nodes\[0\]/);
console.log("Shopify variant SKU match guard tests passed");
