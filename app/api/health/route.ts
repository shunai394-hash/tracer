import {
  getFoundationStatus,
  isCJAutoOrderingEnabled,
  isCJLiveOrderingEnabled,
  isSupplierDryRunEnabled,
} from "@/lib/config/env";

export const runtime = "nodejs";

export async function GET() {
  const status = getFoundationStatus();
  return Response.json({
    ok: true,
    service: "tracer",
    connections: {
      supabase: status.supabasePublic && status.supabaseServiceRole,
      supabasePublic: status.supabasePublic,
      supabaseServiceRole: status.supabaseServiceRole,
      gemini: status.gemini,
      brightData: status.brightData,
      cj: Boolean(process.env.CJ_API_KEY),
      orosy: status.orosy,
      faire: status.faire,
      dsersMcp: status.dsersMcp,
      ecPulse: status.ecPulse,
      newfindInbound: status.newfindInbound,
      newfindOutbound: status.newfindOutbound,
      extension: status.extension,
    },
    automation: {
      cronAuthConfigured: Boolean(process.env.CRON_SECRET),
      baseConfigured: status.base,
      cjLiveOrdering: isCJLiveOrderingEnabled(),
      cjAutoOrdering: isCJAutoOrderingEnabled(),
      supplierDryRun: isSupplierDryRunEnabled(),
    },
  });
}
