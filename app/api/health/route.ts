import { getFoundationStatus } from "@/lib/config/env";

export const runtime = "nodejs";

export async function GET() {
  const status = getFoundationStatus();

  return Response.json({
    ok: true,
    service: "tracer",
    connections: {
      supabase: status.supabasePublic,
      gemini: status.gemini,
      brightData: status.brightData,
    },
  });
}
