import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { TracerV2Stage, TracerV2Outcome } from "./pipeline-contract";

export interface PersistTracerV2StageInput {
  productKey: string;
  stage: TracerV2Stage;
  outcome: TracerV2Outcome;
  idempotencyKey: string;
  externalId?: string | null;
  reason?: string | null;
  evidence?: Record<string, unknown>;
}

export interface PersistTracerV2StageResult {
  ok: boolean;
  duplicate?: boolean;
  eventId?: string;
  reason?: string;
}

/**
 * Writes a verified pipeline stage to the append-only v2 ledger.
 * The database RPC serializes transitions per product and enforces idempotency.
 * Call this only after the corresponding provider/database operation is verified.
 */
export async function persistTracerV2Stage(
  input: PersistTracerV2StageInput,
): Promise<PersistTracerV2StageResult> {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.rpc("record_tracer_v2_pipeline_event", {
    p_product_key: input.productKey,
    p_stage: input.stage,
    p_outcome: input.outcome,
    p_idempotency_key: input.idempotencyKey,
    p_external_id: input.externalId ?? null,
    p_reason: input.reason ?? null,
    p_evidence: input.evidence ?? {},
  });

  if (error) {
    return { ok: false, reason: `pipeline_ledger_write_failed:${error.message}` };
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "pipeline_ledger_invalid_response" };
  }

  const result = data as Record<string, unknown>;
  if (result.ok !== true) {
    const reason = typeof result.reason === "string" ? result.reason : "pipeline_stage_rejected";

    // marketplace_bestsellers rows can be deleted/re-created during recovery,
    // which changes their UUID even though sourceItemKey is the same stable identity.
    // The append-only ledger then rejects the replay because external_id changed.
    // Treat it as a duplicate only after reading back and verifying the exact
    // product key, idempotency key, stage, outcome, and stable sourceItemKey.
    if (
      reason === "idempotency_key_reused_with_different_result" &&
      input.stage === "demand_discovered" &&
      input.outcome === "completed" &&
      typeof input.evidence?.sourceItemKey === "string"
    ) {
      const { data: prior, error: readError } = await db
        .from("tracer_v2_pipeline_events")
        .select("id,stage,outcome,evidence")
        .eq("product_key", input.productKey)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();

      if (!readError && prior &&
          prior.stage === input.stage &&
          prior.outcome === input.outcome &&
          prior.evidence?.sourceItemKey === input.evidence.sourceItemKey) {
        console.warn("[TRACER V2] demand replay matched stable source identity; row UUID changed", {
          productKey: input.productKey,
          sourceItemKey: input.evidence.sourceItemKey,
        });
        return {
          ok: true,
          duplicate: true,
          eventId: typeof prior.id === "string" ? prior.id : undefined,
        };
      }
    }

    return { ok: false, reason };
  }

  return {
    ok: true,
    duplicate: result.duplicate === true,
    eventId: typeof result.event_id === "string" ? result.event_id : undefined,
  };
}
