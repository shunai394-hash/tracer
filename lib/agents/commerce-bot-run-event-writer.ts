import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  validateCommerceBotRunEvent,
  type CommerceBotRunEventInput,
} from "@/lib/agents/commerce-bot-run-evidence";

/**
 * Persist one immutable run event with the service-role client.
 * Duplicate idempotency keys are treated as an idempotent no-op only when the
 * database confirms the existing key; other persistence errors are surfaced.
 */
export async function writeCommerceBotRunEvent(input: unknown): Promise<{ inserted: boolean }> {
  const validation = validateCommerceBotRunEvent(input);
  if (!validation.ok) {
    throw new Error(`invalid_commerce_bot_run_event:${validation.errors.join(",")}`);
  }
  const event: CommerceBotRunEventInput = validation.value;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("commerce_bot_run_events").insert({
    run_id: event.runId,
    bot_id: event.botId,
    event_type: event.eventType,
    status: event.status,
    input_snapshot_hash: event.inputSnapshotHash ?? null,
    evidence_refs: event.evidenceRefs ?? [],
    blockers: event.blockers ?? [],
    retry_count: event.retryCount ?? 0,
    idempotency_key: event.idempotencyKey ?? null,
    metadata: event.metadata ?? {},
  });
  if (!error) return { inserted: true };

  if (event.idempotencyKey && /duplicate key|unique constraint|already exists/i.test(error.message)) {
    const { data, error: lookupError } = await supabase
      .from("commerce_bot_run_events")
      .select("id")
      .eq("idempotency_key", event.idempotencyKey)
      .limit(1)
      .maybeSingle();
    if (!lookupError && data) return { inserted: false };
  }
  throw new Error(`commerce_bot_run_event_insert_failed:${error.message.slice(0, 240)}`);
}
