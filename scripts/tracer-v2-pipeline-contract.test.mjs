import assert from "node:assert/strict";
import { recordTracerV2Stage, type TracerV2ProductState } from "../lib/tracer-v2/pipeline-contract.ts";

let state: TracerV2ProductState = { productKey: "fixture-product", records: [] };
const add = (record: Parameters<typeof recordTracerV2Stage>[1]) => {
  const result = recordTracerV2Stage(state, record);
  assert.equal(result.ok, true, result.reason);
  state = result.state;
};

assert.equal(recordTracerV2Stage(state, {
  stage: "supplier_matched", outcome: "completed", idempotencyKey: "skip-ahead",
  evidence: { supplierProductId: "P1", supplierVariantId: "V1" },
}).reason, "out_of_order_stage:expected=demand_discovered:received=supplier_matched");

add({ stage: "demand_discovered", outcome: "completed", idempotencyKey: "demand-1" });
add({ stage: "variant_evidence_saved", outcome: "completed", idempotencyKey: "variants-1", evidence: { count: 2 } });
add({ stage: "supplier_matched", outcome: "completed", idempotencyKey: "match-1", evidence: { supplierProductId: "P1", supplierVariantId: "V1" } });

assert.equal(recordTracerV2Stage(state, {
  stage: "profitability_checked", outcome: "completed", idempotencyKey: "profit-zero",
  evidence: { contributionProfit: 0 },
}).reason, "positive_verified_contribution_profit_required");

add({ stage: "profitability_checked", outcome: "completed", idempotencyKey: "profit-1", evidence: { contributionProfit: 1200 } });
add({ stage: "base_published", outcome: "completed", idempotencyKey: "base-1", externalId: "base-item-1" });
add({ stage: "shopify_published", outcome: "completed", idempotencyKey: "shopify-1", externalId: "shopify-product-1" });
add({ stage: "newfind_synced", outcome: "completed", idempotencyKey: "newfind-1", externalId: "newfind-product-1" });
add({ stage: "order_received", outcome: "completed", idempotencyKey: "order-1", externalId: "store-order-1" });

assert.equal(recordTracerV2Stage(state, {
  stage: "supplier_order_placed", outcome: "completed", idempotencyKey: "supplier-order-no-id",
}).reason, "supplier_order_id_required");

add({ stage: "supplier_order_placed", outcome: "completed", idempotencyKey: "supplier-order-1", externalId: "CJ-ORDER-1" });
assert.equal(recordTracerV2Stage(state, {
  stage: "tracking_synced", outcome: "completed", idempotencyKey: "tracking-no-id",
}).reason, "tracking_number_required");
add({ stage: "tracking_synced", outcome: "completed", idempotencyKey: "tracking-1", externalId: "TRACK-1" });

const duplicate = recordTracerV2Stage(state, {
  stage: "tracking_synced", outcome: "completed", idempotencyKey: "tracking-1", externalId: "TRACK-1",
});
assert.equal(duplicate.ok, true);
assert.equal(duplicate.state.records.length, 10);

const conflict = recordTracerV2Stage(state, {
  stage: "tracking_synced", outcome: "completed", idempotencyKey: "tracking-1", externalId: "TRACK-CHANGED",
});
assert.equal(conflict.reason, "idempotency_key_reused_with_different_result");

console.log("TRACER v2 pipeline contract tests passed");
