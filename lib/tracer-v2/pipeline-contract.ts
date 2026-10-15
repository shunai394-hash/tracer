export const TRACER_V2_STAGES = [
  "demand_discovered",
  "variant_evidence_saved",
  "supplier_matched",
  "profitability_checked",
  "base_published",
  "shopify_published",
  "newfind_synced",
  "order_received",
  "supplier_order_placed",
  "tracking_synced",
] as const;

export type TracerV2Stage = (typeof TRACER_V2_STAGES)[number];
export type TracerV2Outcome = "completed" | "blocked" | "failed";

export interface TracerV2StageRecord {
  stage: TracerV2Stage;
  outcome: TracerV2Outcome;
  idempotencyKey: string;
  externalId?: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface TracerV2ProductState {
  productKey: string;
  records: TracerV2StageRecord[];
}

export interface TracerV2Transition {
  ok: boolean;
  state: TracerV2ProductState;
  reason?: string;
}

const stageIndex = (stage: TracerV2Stage) => TRACER_V2_STAGES.indexOf(stage);

/**
 * Pure, deterministic state transition contract for the rebuild pipeline.
 * Persistence and external API calls belong to adapters; never mark a stage
 * completed until the adapter has verified the external result.
 */
export function recordTracerV2Stage(
  state: TracerV2ProductState,
  next: TracerV2StageRecord,
): TracerV2Transition {
  if (!state.productKey.trim() || !next.idempotencyKey.trim()) {
    return { ok: false, state, reason: "product_key_and_idempotency_key_required" };
  }

  const prior = state.records.find((record) => record.idempotencyKey === next.idempotencyKey);
  if (prior) {
    const same = prior.stage === next.stage && prior.outcome === next.outcome &&
      prior.externalId === next.externalId;
    return same
      ? { ok: true, state }
      : { ok: false, state, reason: "idempotency_key_reused_with_different_result" };
  }

  const latestCompleted = [...state.records]
    .filter((record) => record.outcome === "completed")
    .sort((a, b) => stageIndex(b.stage) - stageIndex(a.stage))[0];

  if (next.outcome === "completed") {
    const expectedIndex = latestCompleted ? stageIndex(latestCompleted.stage) + 1 : 0;
    if (stageIndex(next.stage) !== expectedIndex) {
      return {
        ok: false,
        state,
        reason: `out_of_order_stage:expected=${TRACER_V2_STAGES[expectedIndex] ?? "pipeline_complete"}:received=${next.stage}`,
      };
    }
    if (next.stage === "supplier_order_placed" && !next.externalId?.trim()) {
      return { ok: false, state, reason: "supplier_order_id_required" };
    }
    if (next.stage === "tracking_synced" && !next.externalId?.trim()) {
      return { ok: false, state, reason: "tracking_number_required" };
    }
    if (next.stage === "profitability_checked") {
      const profit = next.evidence?.contributionProfit;
      if (typeof profit !== "number" || !Number.isFinite(profit) || profit <= 0) {
        return { ok: false, state, reason: "positive_verified_contribution_profit_required" };
      }
    }
    if (next.stage === "supplier_matched") {
      if (next.evidence?.supplierProductId == null || next.evidence?.supplierVariantId == null) {
        return { ok: false, state, reason: "supplier_product_and_variant_ids_required" };
      }
    }
  }

  return { ok: true, state: { ...state, records: [...state.records, next] } };
}
