import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BUCKET = "tracer-drama-bgm";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_TRACKS = 1000;
const ALLOWED_TYPES = new Set(["audio/mpeg", "audio/mp3"]);
const GENRES: Record<string, string> = {
  daily: "daily", romance: "romance", emotional: "emotional", suspense: "suspense", comedy: "comedy", action: "action", "未分類": "未分類",
  "日常・会話": "daily", "恋愛": "romance", "感動・余韻": "emotional", "サスペンス": "suspense", "コメディ": "comedy", "アクション・場面転換": "action",
};
const GENRE_LABELS: Record<string, string> = { daily: "日常・会話", romance: "恋愛", emotional: "感動・余韻", suspense: "サスペンス", comedy: "コメディ", action: "アクション・場面転換", "未分類": "未分類" };

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
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
function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const storage = createSupabaseAdminClient().storage.from(BUCKET);
    const requestedGenre = new URL(request.url).searchParams.get("genre");
    const normalizedGenre = requestedGenre ? GENRES[requestedGenre] : undefined;
    const objects: Array<{ name: string; metadata?: Record<string, unknown> | null }> = [];
    for (let offset = 0; offset < MAX_TRACKS; offset += PAGE_SIZE) {
      const { data, error } = await storage.list("", { limit: PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      const page = data ?? [];
      objects.push(...page.filter(item => item.name.toLowerCase().endsWith(".mp3")));
      if (page.length < PAGE_SIZE || objects.length >= MAX_TRACKS) break;
    }
    const tracks = await Promise.all(objects.slice(0, MAX_TRACKS).map(async item => {
      const rawGenre = typeof item.metadata?.genre === "string" ? item.metadata.genre : "未分類";
      const genre = GENRES[rawGenre] ?? "未分類";
      const { data, error } = await storage.createSignedUrl(item.name, 3600);
      if (error) throw error;
      return { name: item.name, title: item.name.replace(/-[0-9a-f]{8}-[0-9a-f-]{27}\.mp3$/i, "").replace(/\.mp3$/i, ""), genre, genreLabel: GENRE_LABELS[genre] ?? "未分類", url: data.signedUrl };
    }));
    return json({ ok: true, tracks: normalizedGenre ? tracks.filter(t => t.genre === normalizedGenre) : tracks, truncated: objects.length >= MAX_TRACKS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[DRAMA BGM LIBRARY FAILED]", detail);
    return json({ ok: false, error: "bgm_library_unavailable", message: "BGMライブラリを取得できません。Storage bucketとサービスロール設定を確認してください。", detail: detail.slice(0, 300) }, 503);
  }
}

export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  let uploadedObject: string | null = null;
  let supabase: ReturnType<typeof createSupabaseAdminClient> | null = null;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ ok: false, error: "audio_file_required" }, 400);
    if (file.size < 1 || file.size > MAX_FILE_BYTES) return json({ ok: false, error: "audio_file_size_out_of_range", maxBytes: MAX_FILE_BYTES }, 413);
    if (!file.name.toLowerCase().endsWith(".mp3") || (file.type && !ALLOWED_TYPES.has(file.type.toLowerCase()))) return json({ ok: false, error: "mp3_only" }, 415);
    const requestedGenre = String(form.get("genre") || "未分類");
    const genre = GENRES[requestedGenre] ?? "未分類";
    const safeBase = file.name.normalize("NFKC").replace(/\.mp3$/i, "").replace(/[^a-zA-Z0-9ぁ-んァ-ヶ一-龠_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "bgm";
    uploadedObject = safeBase + "-" + randomUUID() + ".mp3";
    const bytes = new Uint8Array(await file.arrayBuffer());
    supabase = createSupabaseAdminClient();
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(uploadedObject, bytes, { contentType: "audio/mpeg", upsert: false, metadata: { genre } });
    if (uploadError) throw uploadError;
    const { data: signed, error: signedError } = await supabase.storage.from(BUCKET).createSignedUrl(uploadedObject, 3600);
    if (signedError) throw signedError;
    console.info("[DRAMA BGM UPLOAD SUCCEEDED]", { object: uploadedObject, bytes: file.size, genre });
    return json({ ok: true, track: { name: uploadedObject, title: safeBase, genre, genreLabel: GENRE_LABELS[genre] ?? "未分類", url: signed.signedUrl } }, 201);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[DRAMA BGM UPLOAD FAILED]", { object: uploadedObject, detail });
    if (uploadedObject && supabase) await supabase.storage.from(BUCKET).remove([uploadedObject]).catch(() => undefined);
    return json({ ok: false, error: "bgm_upload_failed", message: "BGMを保存できませんでした。Storage bucketとサービスロール設定を確認してください。", detail: detail.slice(0, 300) }, 503);
  }
}
