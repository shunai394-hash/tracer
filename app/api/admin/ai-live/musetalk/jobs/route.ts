import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function authorize(request: Request) {
  if (authorizedAdminToken(request)) return null;
  return requireAutomationAuth(request);
}
function isAllowedStorageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".supabase.co") && !url.username && !url.password;
  } catch { return false; }
}
export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  try {
    const db = createSupabaseAdminClient();
    let query = db.from("ai_live_musetalk_jobs")
      .select("id,status,output_video_url,error_message,requested_by,attempt_count,created_at,updated_at,completed_at")
      .order("created_at", { ascending: false }).limit(30);
    if (id) query = query.eq("id", id);
    const { data, error } = await query;
    if (error) throw error;
    return json({ ok: true, jobs: data ?? [] });
  } catch {
    return json({ ok: false, error: "musetalk_queue_unavailable", message: "MuseTalkキューを読み込めません。DBマイグレーションを確認してください。" }, 503);
  }
}
export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  let input: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, error: "invalid_json" }, 400);
    input = value as Record<string, unknown>;
  } catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const imageUrl = input.imageUrl;
  const audioUrl = input.audioUrl;
  const requestedBy = typeof input.requestedBy === "string" ? input.requestedBy.trim() : "muse";
  if (!isAllowedStorageUrl(imageUrl) || !isAllowedStorageUrl(audioUrl) || !requestedBy || requestedBy.length > 80) {
    return json({ ok: false, error: "invalid_input", message: "画像・音声はHTTPSのSupabase Storage URLを指定してください。" }, 400);
  }
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("ai_live_musetalk_jobs").insert({
      input_image_url: imageUrl, input_audio_url: audioUrl, requested_by: requestedBy,
    }).select("id,status,requested_by,created_at").single();
    if (error) throw error;
    return json({ ok: true, job: data }, 201);
  } catch {
    return json({ ok: false, error: "musetalk_enqueue_failed", message: "生成依頼を登録できませんでした。DBマイグレーションを確認してください。" }, 503);
  }
}
