import { getFoundationStatus } from "@/lib/config/env";

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
      cj: status.cj,
      ecPulse: status.ecPulse,
      newfindInbound: status.newfindInbound,
      newfindOutbound: status.newfindOutbound,
      extension: status.extension,
    },
  });
}
