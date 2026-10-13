import { isSupplierIdentityEligible } from "../lib/catalog/supplier-identity-policy.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [shopify, basePublisher, identity, shopifyRoute, baseRoute, vercel] = await Promise.all([
  readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/catalog/canonical-supplier-identity.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/shopify-publish/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/base-publish/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
]);

// These are regression contracts for the real cron-to-service call paths.
// External writes remain disabled in this test: it only inspects source.
// Behavioral tests for the shared identity/currency policy. No external API or DB writes.
const validIdentity = {
  candidateCount: 1,
  candidateProductId: "canonical-1",
  candidateSupplierProductId: "supplier-product-1",
  candidateVariantId: "variant-1",
  candidateSellingCurrency: "JPY",
  sourceIdentityStatus: "linked",
  sourceProductId: "canonical-1",
  sourceSupplierProductId: "supplier-product-1",
  sourceVariantId: "variant-1",
  sourceCurrency: "JPY",
};
assert.equal(isSupplierIdentityEligible(validIdentity), true);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, candidateCount: 0 }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, candidateCount: 2 }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, sourceIdentityStatus: "unverified" }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, sourceProductId: "other-product" }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, sourceSupplierProductId: "other-supplier-product" }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, sourceVariantId: "other-variant" }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, sourceVariantId: null }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, sourceCurrency: "USD" }), false);
assert.equal(isSupplierIdentityEligible({ ...validIdentity, sourceCurrency: null }), false);

assert.match(shopifyRoute, /syncPublishedListingsToShopify\(150\)/);
assert.match(baseRoute, /publishPublishedListingsToBase\(50\)/);
assert.match(shopify, /getExactlyEligibleSupplierListingIds/);
assert.match(basePublisher, /getExactlyEligibleSupplierListingIds/);
assert.match(identity, /sourceProductId === canonicalProductId/);
assert.match(identity, /sourceSupplierProductId === listingSupplierProductId/);
assert.match(identity, /sourceVariantId === listingVariantId/);
assert.match(identity, /sourceCurrency === sellingCurrency/);
assert.match(identity, /candidateGroup.length !== 1/);
assert.match(shopify, /supplier_variant_missing/);
assert.match(shopify, /supplier_product_missing/);
assert.match(shopify, /canonical_product_id_missing/);
assert.match(shopify, /currency_not_jpy/);
assert.match(shopify, /inventory_zero_or_unknown/);
assert.match(shopify, /profit_not_positive/);
assert.match(shopify, /margin_not_positive/);
assert.match(basePublisher, /supplier_variant_identity_missing/);
assert.match(basePublisher, /source_cost_unknown_or_invalid/);
assert.match(basePublisher, /profit_not_positive_or_unknown/);
assert.match(basePublisher, /margin_not_positive_or_unknown/);
assert.match(basePublisher, /base_economics_block_hide_failed/);

// The established patrol loop is preserved; the safety patch must not silently
// remove scheduled monitoring while tightening publication gates.
const vercelConfig = JSON.parse(vercel);
assert.ok(
  vercelConfig.crons.some((cron) => cron.path === "/api/cron/patrol-ai"),
  "the existing patrol-ai cron must remain configured",
);
console.log("Canonical channel safety contracts passed.");
