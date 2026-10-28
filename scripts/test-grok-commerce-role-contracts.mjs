import assert from "node:assert/strict";
import {
  buildLocalizationPatch,
  buildRoleReport,
  diffChannelSnapshot,
  evaluateSellability,
} from "../lib/ops/grok-commerce-role-contracts.ts";

const now = new Date("2026-10-28T03:00:00.000Z");
const validEvidence = {
  supplierProductId: "cj-product-1",
  supplierVariantId: "cj-variant-1",
  stock: 5,
  supplierCost: 1000,
  japanShipping: 500,
  observedAt: "2026-10-28T02:50:00.000Z",
  japaneseTitle: "日本語の商品名",
  positiveProfit: true,
  trackingAvailable: true,
};

assert.equal(evaluateSellability(validEvidence, now).sellable, true);
const stale = evaluateSellability({ ...validEvidence, observedAt: "2026-10-28T01:00:00.000Z" }, now);
assert.equal(stale.sellable, false);
assert.ok(stale.missing.includes("freshEvidence"));
const unknownVariant = evaluateSellability({ ...validEvidence, supplierVariantId: "" }, now);
assert.ok(unknownVariant.missing.includes("supplierVariantId"));

const localization = buildLocalizationPatch({
  title: " 日本語タイトル ",
  description: " 日本語説明 ",
  variantText: " 赤 ",
  price: 1,
  inventory: 999,
  published: true,
  id: "changed-id",
  sku: "wrong-sku",
});
assert.deepEqual(localization.patch, {
  title: "日本語タイトル",
  description: "日本語説明",
  variantText: "赤",
});
assert.deepEqual(localization.rejectedFields.sort(), ["id", "inventory", "price", "published", "sku"]);

const same = diffChannelSnapshot(
  { id: "canonical-1", price: 2000, inventory: 3, published: true, sku: "TRC-1", variantId: "v1", title: "日本語", description: "説明" },
  { id: "base-1", price: 2000, inventory: 3, published: true, sku: "TRC-1", variantId: "v1", title: "日本語", description: "説明" },
);
assert.equal(same.matches, true);
const mismatch = diffChannelSnapshot(
  { id: "canonical-1", price: 2000, inventory: 3, published: true, sku: "TRC-1", variantId: "v1", title: "日本語", description: "説明" },
  { id: "shopify-1", price: 1900, inventory: 0, published: false, sku: "TRC-1", variantId: "v1", title: "日本語", description: "説明" },
);
assert.deepEqual(mismatch.differences.map((item) => item.field), ["price", "inventory", "published"]);

assert.equal(buildRoleReport({ runId: "run-1", role: "main", scanned: 0, changed: 0, failed: 0, skipped: 0 }).status, "NOOP");
assert.equal(buildRoleReport({ runId: "run-2", role: "qa", scanned: 4, changed: 0, failed: 1, skipped: 0 }).status, "attention_required");
assert.throws(() => buildRoleReport({ runId: "", role: "main", scanned: 0, changed: 0, failed: 0, skipped: 0 }), /invalid_role_report/u);

console.log("Grok-style commerce role contracts passed (11 assertions).");
