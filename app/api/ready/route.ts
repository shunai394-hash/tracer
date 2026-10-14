import {
  getFoundationStatus,
  isCJAutoOrderingEnabled,
  isCJLiveOrderingEnabled,
  isSupplierDryRunEnabled,
} from "@/lib/config/env";

export const runtime = "nodejs";

/**
 * Readiness means the app has the core database configuration needed to serve
 * authenticated, data-backed workflows. Optional supplier/AI/channel adapters
 * are reported separately so a missing integration is visible without
 * incorrectly declaring the entire app ready for automated commerce.
 */
export async function GET() {
  const status = getFoundationStatus();
  const missingRequired: string[] = [];

  if (!status.supabasePublic) missingRequired.push("supabase_public");
  if (!status.supabaseServiceRole) missingRequired.push("supabase_service_role");

  const ready = missingRequired.length === 0;

  return Response.json(
    {
      ok: ready,
      ready,
      service: "tracer",
      missingRequired,
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
