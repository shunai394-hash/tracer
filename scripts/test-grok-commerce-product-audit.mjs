import assert from "node:assert/strict";
import { auditCommerceProduct, auditCommerceProducts } from "../lib/ops/grok-commerce-product-audit.ts";

const now = new Date("2026-10-28T06:00:00.000Z");
const valid = {
  productId: "p-1",
  evidence: {
    supplierProductId: "supplier-p",
    supplierVariantId: "supplier-v",
    stock: 5,
    supplierCost: 100,
    japanShipping: 20,
    observedAt: "2026-10-28T05:45:00.000Z",
    japaneseTitle: "日本語の商品名",
    positiveProfit: true,
    trackingAvailable: true,
  },
  canonical: { id: "canonical-1", price: 300, inventory: 5, published: true, sku: "SKU-1", variantId: "v-1" },
  channels: [
    { channel: "BASE", listing: { id: "base-1", price: 300, inventory: 5, published: true, sku: "SKU-1", variantId: "v-1", title: "日本語の商品名" } },
    { channel: "Shopify", listing: { id: "shopify-1", price: 300, inventory: 5, published: true, sku: "SKU-1", variantId: "v-1", title: "日本語の商品名" } },
  ],
  description: "日本語の商品説明",
};

const ok = auditCommerceProduct(valid, now);
assert.equal(ok.issueCount, 0);
assert.equal(ok.sellable, true);
assert.equal(ok.readOnly, true);
assert.equal(ok.writesPerformed, false);

const broken = auditCommerceProduct({
  ...valid,
  productId: "p-2",
  evidence: { ...valid.evidence, supplierVariantId: null, stock: 0, observedAt: "2026-10-28T04:00:00.000Z", japaneseTitle: "English only" },
  channels: [
    { channel: "BASE", listing: { ...valid.channels[0].listing, id: "", price: 350, title: "English product" } },
    { channel: "Shopify", listing: null },
  ],
}, now);
assert.equal(broken.sellable, false);
assert.ok(broken.issues.some((issue) => issue.code === "sellability_missing_supplierVariantId"));
assert.ok(broken.issues.some((issue) => issue.code === "sellability_missing_positiveStock"));
assert.ok(broken.issues.some((issue) => issue.code === "channel_parity_mismatch_BASE_price"));
assert.ok(broken.issues.some((issue) => issue.code === "channel_listing_missing_Shopify"));

const aggregate = auditCommerceProducts([valid, { ...valid, productId: "p-3", channels: [] }], now);
assert.equal(aggregate.scanned, 2);
assert.equal(aggregate.withIssues, 0);
assert.equal(aggregate.writesPerformed, false);

console.log("grok-commerce-product-audit: all assertions passed");
