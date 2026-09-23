import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  evaluateKillSwitches,
  type KillSwitchContext,
  type KillSwitchEvaluation,
  type KillSwitchRow,
  type KillSwitchScope,
} from "@/lib/ops/kill-switch-eval";

export type { KillSwitchContext, KillSwitchEvaluation, KillSwitchRow, KillSwitchScope };
export { evaluateKillSwitches };

function mapRow(row: Record<string, unknown>): KillSwitchRow {
  return {
    id: String(row.id),
    scope: row.scope as KillSwitchScope,
    scopeKey: String(row.scope_key ?? ""),
    active: row.active === true,
    reason: typeof row.reason === "string" ? row.reason : null,
    createdBy: typeof row.created_by === "string" ? row.created_by : null,
    updatedAt: String(row.updated_at),
  };
}

export async function listKillSwitches(): Promise<KillSwitchRow[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("kill_switches")
    .select("*")
    .order("scope", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapRow(row as Record<string, unknown>));
}

export async function setKillSwitch(args: {
  scope: KillSwitchScope;
  scopeKey?: string;
  active: boolean;
  reason?: string | null;
  createdBy?: string | null;
}): Promise<KillSwitchRow> {
  const supabase = createSupabaseAdminClient();
  const scopeKey = args.scope === "global" ? "" : (args.scopeKey ?? "");

  if (args.scope !== "global" && !scopeKey) {
    throw new Error(`scopeKey is required for scope=${args.scope}`);
  }

  const { data, error } = await supabase
    .from("kill_switches")
    .upsert(
      {
        scope: args.scope,
        scope_key: scopeKey,
        active: args.active,
        reason: args.reason ?? null,
        created_by: args.createdBy ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "scope,scope_key" },
    )
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return mapRow(data as Record<string, unknown>);
}

/**
 * Fetch active switches and evaluate them against a context in one call — the
 * shape callers (order execution, ad sync, teacher weight apply) actually need.
 */
export async function checkKillSwitch(
  context: KillSwitchContext,
): Promise<KillSwitchEvaluation> {
  const switches = await listKillSwitches();
  return evaluateKillSwitches(switches, context);
}
