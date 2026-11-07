import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptYouTubeRefreshToken } from "@/lib/ai-live/youtube-token-crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizedWorker(request: Request): boolean {
  const expected = process.env.AI_LIVE_WORKER_TOKEN ?? "";
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Internal worker endpoint. Never expose this response to browser clients. */
export async function GET(request: Request) {
  if (!authorizedWorker(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("ai_live_oauth_credentials")
      .select("ciphertext,iv,auth_tag,scope")
      .eq("id", "youtube_primary")
      .eq("provider", "youtube")
      .maybeSingle();
    if (error || !data || data.scope !== "https://www.googleapis.com/auth/youtube") {
      return NextResponse.json({ ok: false, error: "youtube_not_connected" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const refreshToken = decryptYouTubeRefreshToken({
      ciphertext: data.ciphertext,
      iv: data.iv,
      authTag: data.auth_tag,
    });
    return NextResponse.json({
      ok: true,
      clientId: process.env.YOUTUBE_CLIENT_ID ?? "",
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
      refreshToken,
    }, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ ok: false, error: "youtube_credentials_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
