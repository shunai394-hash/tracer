import assert from "node:assert/strict";
import { runReadOnlyOperationsBots } from "../lib/ops-bots/read-only-orchestrator.ts";

const product = {
  tracerProductId: "tracer-001",
  supplierProductId: "supplier-100",
  supplierVariantId: "variant-red",
  sku: "TRC-001-RED",
  title: "日本語の商品名",
  description: "日本語の商品説明です。",
  supplierCost: 1000,
  japanShippingCost: 300,
  sellingPrice: 2980,
  stock: 5,
  trackingAvailable: true,
  shouldBePublic: true,
  updatedAt: "2026-10-28T01:00:00.000Z",
  channels: {
    BASE: { externalProductId: "base-123", sku: "TRC-001-RED", sellingPrice: 2980, stock: 5, published: true, observedAt: "2026-10-28T01:00:00.000Z" },
    Shopify: { externalProductId: "shopify-456", externalVariantId: "shopify-variant-456", sku: "TRC-001-RED", sellingPrice: 2980, stock: 5, published: true, observedAt: "2026-10-28T01:00:00.000Z" },
    NEWFIND: { externalProductId: "newfind-789", sku: "TRC-001-RED", sellingPrice: 2980, stock: 5, published: true, observedAt: "2026-10-28T01:00:00.000Z" },
  },
};

const clean = runReadOnlyOperationsBots({ products: [product], generatedAt: "2026-10-28T02:00:00.000Z" });
assert.equal(clean.mode, "read-only");
assert.equal(clean.findingCount, 0);
assert.equal(clean.tasks.length, 0);

const changed = runReadOnlyOperationsBots({
  products: [{ ...product, supplierCost: 1300, stock: 3, title: "Redwood Product", channels: {
    ...product.channels,
    BASE: { ...product.channels.BASE, sellingPrice: 2700, stock: 4, sku: "wrong-sku" },
  } }],
  previousProducts: [product],
});
assert.ok(changed.findings.some((f) => f.code === "LANDED_COST_CHANGED"));
assert.ok(changed.findings.some((f) => f.code === "STOCK_CHANGED"));
assert.ok(changed.findings.some((f) => f.code === "TITLE_NEEDS_JAPANESE_REVIEW"));
assert.ok(changed.findings.some((f) => f.code === "CHANNEL_IDENTITY_MISMATCH" && f.channels.includes("BASE")));
assert.ok(changed.findings.some((f) => f.code === "CHANNEL_PRICE_MISMATCH" && f.channels.includes("BASE")));
assert.ok(changed.findings.some((f) => f.code === "CHANNEL_STOCK_MISMATCH" && f.channels.includes("BASE")));
assert.ok(changed.tasks.every((task) => task.readOnly === true));

const missingIdentity = runReadOnlyOperationsBots({ products: [{ ...product, supplierVariantId: null }] });
assert.ok(missingIdentity.findings.some((f) => f.code === "IDENTITY_INCOMPLETE" && f.severity === "critical"));

const duplicateIdentity = runReadOnlyOperationsBots({ products: [product, { ...product, title: "別タイトル" }] });
assert.ok(duplicateIdentity.findings.some((f) => f.code === "DUPLICATE_STABLE_IDENTITY"));

const unknownCost = runReadOnlyOperationsBots({ products: [{ ...product, supplierCost: null, japanShippingCost: null }] });
assert.ok(unknownCost.findings.some((f) => f.code === "SUPPLIER_COST_OR_SHIPPING_UNKNOWN" && f.requiresHumanApproval));
console.log("Read-only multi-bot orchestrator: 12 assertions passed");
