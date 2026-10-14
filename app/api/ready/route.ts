import {
  getFoundationStatus,
  isCJAutoOrderingEnabled,
  isCJLiveOrderingEnabled,
  isSupplierDryRunEnabled,
} from "@/lib/config/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Readiness checks both required configuration and a bounded, read-only query.
 * Optional adapters are reported separately and never imply commerce readiness.
 */
export async function GET() {
  const status = getFoundationStatus();
  const missingRequired: string[] = [];

  if (!status.supabasePublic) missingRequired.push("supabase_public");
  if (!status.supabaseServiceRole) missingRequired.push("supabase_service_role");

  let databaseReachable = false;
  if (missingRequired.length === 0) {
    try {
      const { error } = await createSupabaseAdminClient()
        .from("shop_listings")
        .select("id")
        .limit(1)
        .abortSignal(AbortSignal.timeout(5000));
      databaseReachable = !error;
    } catch {
      databaseReachable = false;
    }
  }

  if (missingRequired.length === 0 && !databaseReachable) {
    missingRequired.push("supabase_query_failed");
  }

  const ready = missingRequired.length === 0;

  return Response.json(
    {
      ok: ready,
      ready,
      service: "tracer",
      missingRequired,
      database: {
        configured: status.supabasePublic && status.supabaseServiceRole,
        reachable: databaseReachable,
        check: "read_only_shop_listings_query",
      },
      connections: {
        supabase: status.supabasePublic && status.supabaseServiceRole,
        supabasePublic: status.supabasePublic,
        supabaseServiceRole: status.supabaseServiceRole,
        gemini: status.gemini,
        brightData: status.brightData,
        shopify: status.shopify,
        cj: Boolean(process.env.CJ_API_KEY),
        orosy: status.orosy,
        faire: status.faire,
        dsersMcp: status.dsersMcp,
        ecPulse: status.ecPulse,
        newfindInbound: status.newfindInbound,
        newfindOutbound: status.newfindOutbound,
        base: status.base,
      },
      automation: {
        cronAuthConfigured: Boolean(process.env.CRON_SECRET),
        cjLiveOrdering: isCJLiveOrderingEnabled(),
        cjAutoOrdering: isCJAutoOrderingEnabled(),
        supplierDryRun: isSupplierDryRunEnabled(),
      },
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
