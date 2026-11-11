import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabasePublicConfig } from "@/lib/config/env";

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
    const supabase = createSupabaseAdminClient();
    const storage = supabase.storage.from(BUCKET);
    const requestedGenre = new URL(request.url).searchParams.get("genre");
    const normalizedGenre = requestedGenre ? GENRES[requestedGenre] : undefined;
    let query = supabase
      .from("ai_live_bgm_rights")
      .select("storage_object,title,genre")
      .eq("review_status", "approved_internal")
      .order("title", { ascending: true })
      .limit(MAX_TRACKS);
    if (normalizedGenre && normalizedGenre !== "未分類") {
      query = query.eq("genre", normalizedGenre);
    }
    const { data: approved, error: ledgerError } = await query;
    if (ledgerError) throw ledgerError;

    const tracks = await Promise.all((approved ?? []).map(async (item) => {
      const { data: signed, error } = await storage.createSignedUrl(item.storage_object, 60 * 60);
      if (error) throw error;
      const genre = GENRES[item.genre] ?? "未分類";
      return {
        name: item.storage_object,
        title: item.title,
        genre,
        genreLabel: GENRE_LABELS[genre] ?? "未分類",
        url: signed.signedUrl,
      };
    }));

    return json({ ok: true, tracks, truncated: (approved ?? []).length >= MAX_TRACKS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[DRAMA BGM LIBRARY FAILED]", detail);
    return json({ ok: false, error: "bgm_library_unavailable", message: "BGMライブラリを取得できません。権利台帳とStorage設定を確認してください。", detail: detail.slice(0, 300) }, 503);
  }
}

export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await request.json() as { action?: string; fileName?: string; size?: number; contentType?: string; genre?: string };
      if (body.action === "complete") {
        const objectName = String(body.objectName ?? "");
        const title = String(body.title ?? "").trim().slice(0, 100);
        const requestedGenre = String(body.genre || "未分類");
        const genre = GENRES[requestedGenre] ?? "未分類";
        if (!body.rightsConfirmed) {
          return json({ ok: false, error: "rights_confirmation_required", message: "自作または利用許諾済みであることを確認してください。" }, 400);
        }
        if (!objectName || objectName.includes("/") || !objectName.toLowerCase().endsWith(".mp3") || !title) {
          return json({ ok: false, error: "bgm_metadata_invalid" }, 400);
        }
        const supabase = createSupabaseAdminClient();
        const storage = supabase.storage.from(BUCKET);
        const { data: existing, error: existingError } = await supabase
          .from("ai_live_bgm_rights")
          .select("id,storage_object,title,genre,review_status")
          .eq("storage_object", objectName)
          .maybeSingle();
        if (existingError) throw existingError;
        if (existing) return json({ ok: true, track: { name: existing.storage_object, title: existing.title, genre: existing.genre, reviewStatus: existing.review_status }, alreadyRegistered: true });
        const { data: objects, error: objectError } = await storage.list("", { search: objectName, limit: 10 });
        if (objectError) throw objectError;
        if (!(objects ?? []).some((item) => item.name === objectName)) {
          return json({ ok: false, error: "uploaded_object_not_found", message: "Storage上にアップロード済み音源を確認できません。" }, 409);
        }
        const { error: insertError } = await supabase.from("ai_live_bgm_rights").insert({
          storage_object: objectName,
          title,
          composer: "ユーザー登録音源",
          genre,
          license_name: "管理者申告：自作または利用許諾済み",
          license_checked_at: new Date().toISOString(),
          license_scope: "TRACER内のドラマ制作・配信・商用利用",
          commercial_use_allowed: true,
          platform_use_allowed: true,
          redistribution_allowed: false,
          end_user_use_allowed: true,
          attribution_required: false,
          evidence_note: "BGM登録画面で管理者が自作または利用許諾済みであることを確認して登録。",
          review_status: "approved_internal",
          reviewed_by: "TRACER_ADMIN",
          reviewed_at: new Date().toISOString(),
        });
        if (insertError) throw insertError;
        return json({ ok: true, track: { name: objectName, title, genre, reviewStatus: "approved_internal" } }, 201);
      }
      if (body.action !== "prepare") return json({ ok: false, error: "unsupported_action" }, 400);
      const fileName = String(body.fileName ?? "");
      const size = Number(body.size ?? 0);
      const mimeType = String(body.contentType ?? "").toLowerCase();
      if (!fileName.toLowerCase().endsWith(".mp3") || !Number.isFinite(size) || size < 1 || size > MAX_FILE_BYTES) {
        return json({ ok: false, error: "audio_file_size_or_name_invalid", maxBytes: MAX_FILE_BYTES }, 400);
      }
      if (mimeType && !ALLOWED_TYPES.has(mimeType)) return json({ ok: false, error: "mp3_only" }, 415);
      const requestedGenre = String(body.genre || "未分類");
      const genre = GENRES[requestedGenre] ?? "未分類";
      const safeBase = fileName.normalize("NFKC").replace(/\.mp3$/i, "").replace(/[^a-zA-Z0-9ぁ-んァ-ヶ一-龠_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "bgm";
      const genrePrefix = genre === "未分類" ? "uncategorized" : genre;
      const objectName = genrePrefix + "--" + safeBase + "-" + randomUUID() + ".mp3";
      const supabase = createSupabaseAdminClient();
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(objectName, { upsert: false });
      if (error) throw error;
      const { url } = getSupabasePublicConfig();
      const uploadUrl = new URL(data.signedUrl, url).toString();
      console.info("[DRAMA BGM SIGNED UPLOAD CREATED]", { object: objectName, bytes: size, genre });
      return json({ ok: true, upload: { url: uploadUrl, token: data.token, path: data.path }, track: { name: objectName, title: safeBase, genre, genreLabel: GENRE_LABELS[genre] ?? "未分類" } }, 201);
    }

    // Retain the legacy multipart path for small clients; large MP3 files use the signed direct-upload flow above.
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ ok: false, error: "audio_file_required" }, 400);
    if (file.size < 1 || file.size > 4 * 1024 * 1024) return json({ ok: false, error: "direct_upload_required", message: "このサイズのMP3はStorage直接アップロード方式が必要です。" }, 413);
    if (!file.name.toLowerCase().endsWith(".mp3") || (file.type && !ALLOWED_TYPES.has(file.type.toLowerCase()))) return json({ ok: false, error: "mp3_only" }, 415);
    const requestedGenre = String(form.get("genre") || "未分類");
    const genre = GENRES[requestedGenre] ?? "未分類";
    const safeBase = file.name.normalize("NFKC").replace(/\.mp3$/i, "").replace(/[^a-zA-Z0-9ぁ-んァ-ヶ一-龠_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "bgm";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.storage.from(BUCKET).upload(safeBase + "-" + randomUUID() + ".mp3", bytes, { contentType: "audio/mpeg", upsert: false, metadata: { genre } });
    if (error) throw error;
    return json({ ok: true, legacyUpload: true }, 201);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[DRAMA BGM UPLOAD PREPARE FAILED]", { detail });
    return json({ ok: false, error: "bgm_upload_prepare_failed", message: "Storageへのアップロード準備に失敗しました。", detail: detail.slice(0, 300) }, 503);
  }
}
