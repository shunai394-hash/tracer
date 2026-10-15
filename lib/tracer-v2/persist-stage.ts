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
    return {
      ok: false,
      reason: typeof result.reason === "string" ? result.reason : "pipeline_stage_rejected",
    };
  }

  return {
    ok: true,
    duplicate: result.duplicate === true,
    eventId: typeof result.event_id === "string" ? result.event_id : undefined,
  };
}
