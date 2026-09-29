import { getFoundationStatus } from "@/lib/config/env";

export const runtime = "nodejs";

export async function GET() {
  const status = getFoundationStatus();
  const supabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim());
  const supabasePublishableKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim());
  const supabaseAnonKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim());

  return Response.json({
    ok: true,
    service: "tracer",
    connections: {
      supabase: status.supabasePublic && status.supabaseServiceRole,
      supabasePublic: status.supabasePublic,
      supabaseServiceRole: status.supabaseServiceRole,
      supabaseUrl,
      supabasePublishableKey,
      supabaseAnonKey,
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
