import { isGeminiConfigured } from "@/lib/ai/gemini";
import { isBrightDataConfigured } from "@/lib/sources/brightdata";
import { isMcpConfigured } from "@/lib/sources/mcp";
import { isSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    supabase: isSupabaseConfigured(),
    gemini: isGeminiConfigured(),
    brightData: isBrightDataConfigured(),
    mcp: isMcpConfigured(),
  });
}
