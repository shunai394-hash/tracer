import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
async function authorize(request: Request) {
  if (authorizedAdminToken(request)) return null;
  return await requireAutomationAuth(request);
}
function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function dramaKey(title: string) {
  return title.normalize("NFKC").trim().toLocaleLowerCase("ja-JP").replace(/\s+/g, " ").slice(0, 100);
}
function validCast(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 30) return false;
  return value.every((person) => !!person && typeof person === "object" && !Array.isArray(person)
    && typeof person.name === "string" && person.name.trim().length > 0 && person.name.length <= 40
    && typeof person.voiceId === "string" && person.voiceId.length <= 128
    && (person.imageUrl === undefined || typeof person.imageUrl === "string" && person.imageUrl.length <= 1000 && (!person.imageUrl || /^https:\/\//i.test(person.imageUrl)))
    && (person.mouthX === undefined || Number.isFinite(Number(person.mouthX)))
    && (person.mouthY === undefined || Number.isFinite(Number(person.mouthY))));
}
export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  const title = (new URL(request.url).searchParams.get("title") || "").trim();
  if (!title || title.length > 100) return json({ ok: false, error: "invalid_drama_title" }, 400);
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db.from("ai_live_drama_casts").select("title,cast_data,updated_at").eq("drama_key", dramaKey(title)).maybeSingle();
    if (error) throw error;
    if (!data) return json({ ok: false, error: "cast_not_found", message: "このドラマの保存済み配役はまだありません。" }, 404);
    return json({ ok: true, title: data.title, cast: data.cast_data, updatedAt: data.updated_at });
  } catch {
    return json({ ok: false, error: "cast_registry_unavailable", message: "ドラマ別配役台帳を読み込めません。マイグレーション適用状況を確認してください。" }, 503);
  }
}
export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  let input: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, error: "invalid_json_object" }, 400);
    input = value as Record<string, unknown>;
  } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const cast = input.cast;
  if (!title || title.length > 100 || !validCast(cast)) return json({ ok: false, error: "invalid_cast", message: "ドラマ名と30人以内の配役を確認してください。" }, 400);
  try {
    const db = createSupabaseAdminClient();
    const { error } = await db.from("ai_live_drama_casts").upsert({
      drama_key: dramaKey(title), title, cast_data: cast, updated_at: new Date().toISOString(),
    }, { onConflict: "drama_key" });
    if (error) throw error;
    return json({ ok: true, title, count: cast.length, message: "ドラマ別の配役を保存しました。" });
  } catch {
    return json({ ok: false, error: "cast_save_failed", message: "配役を保存できませんでした。マイグレーション適用状況を確認してください。" }, 503);
  }
}
