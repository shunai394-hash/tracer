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
const GENRES = new Set(["日常・会話", "恋愛", "感動・余韻", "サスペンス", "コメディ", "アクション・場面転換", "未分類"]);

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function authorize(request: Request) {
  if (authorizedAdminToken(request)) return null;
  return requireAutomationAuth(request);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const supabase = createSupabaseAdminClient();
    const storage = supabase.storage.from(BUCKET);
    const requestedGenre = new URL(request.url).searchParams.get("genre");
    const allowedGenres = new Set(["daily", "romance", "emotional", "suspense", "comedy", "action"]);
    let query = supabase
      .from("ai_live_bgm_rights")
      .select("storage_object,title,genre")
      .eq("review_status", "approved_internal")
      .order("title", { ascending: true })
      .limit(MAX_TRACKS);
    if (requestedGenre && allowedGenres.has(requestedGenre)) {
      query = query.eq("genre", requestedGenre);
    }
    const { data: approved, error: ledgerError } = await query;
    if (ledgerError) throw ledgerError;

    const tracks = await Promise.all((approved ?? []).map(async (item) => {
      const { data: signed, error } = await storage.createSignedUrl(item.storage_object, 60 * 60);
      if (error) throw error;
      return {
        name: item.storage_object,
        title: item.title,
        genre: item.genre,
        url: signed.signedUrl,
      };
    }));

    return json({ ok: true, tracks, truncated: (approved ?? []).length >= MAX_TRACKS });
  } catch {
    return json({
      ok: false,
      error: "bgm_library_unavailable",
      message: "BGMライブラリを取得できません。Supabase Storageのbucket設定を確認してください。",
    }, 503);
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
    if (file.size < 1 || file.size > MAX_FILE_BYTES) {
      return json({ ok: false, error: "audio_file_size_out_of_range", maxBytes: MAX_FILE_BYTES }, 413);
    }
    if (!file.name.toLowerCase().endsWith(".mp3") || (file.type && !ALLOWED_TYPES.has(file.type.toLowerCase()))) {
      return json({ ok: false, error: "mp3_only" }, 415);
    }

    const requestedGenre = String(form.get("genre") || "未分類");
    const genre = GENRES.has(requestedGenre) ? requestedGenre : "未分類";
    const safeBase = file.name.normalize("NFKC")
      .replace(/\.mp3$/i, "")
      .replace(/[^a-zA-Z0-9ぁ-んァ-ヶ一-龠_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "bgm";
    uploadedObject = safeBase + "-" + randomUUID() + ".mp3";
    const bytes = new Uint8Array(await file.arrayBuffer());
    supabase = createSupabaseAdminClient();

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(uploadedObject, bytes, {
      contentType: "audio/mpeg",
      upsert: false,
      metadata: { genre },
    });
    if (uploadError) throw uploadError;

    const { data: signed, error: signedError } = await supabase.storage.from(BUCKET).createSignedUrl(uploadedObject, 60 * 60);
    if (signedError) throw signedError;

    return json({
      ok: true,
      track: { name: uploadedObject, title: safeBase, genre, url: signed.signedUrl },
    }, 201);
  } catch {
    if (uploadedObject && supabase) {
      await supabase.storage.from(BUCKET).remove([uploadedObject]).catch(() => undefined);
    }
    return json({
      ok: false,
      error: "bgm_upload_failed",
      message: "BGMを保存できませんでした。Storage bucketとサービスロール設定を確認してください。",
    }, 503);
  }
}
