import { isBrightDataFetchConfigured } from "@/lib/sources/brightdata/client";
import {
  getFoundationStatus,
  isCJAutoOrderingEnabled,
  isCJLiveOrderingEnabled,
  isSupplierDryRunEnabled,
} from "@/lib/config/env";

export const runtime = "nodejs";

export async function GET() {
  const status = getFoundationStatus();
  const brightDataMcp = isBrightDataFetchConfigured();
  return Response.json({
    ok: true,
    service: "tracer",
    connections: {
      supabase: status.supabasePublic && status.supabaseServiceRole,
      supabasePublic: status.supabasePublic,
      supabaseServiceRole: status.supabaseServiceRole,
      gemini: status.gemini,
      brightData: status.brightData || brightDataMcp,
      brightDataApi: status.brightData,
      brightDataMcp,
      cj: Boolean(process.env.CJ_API_KEY),
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
