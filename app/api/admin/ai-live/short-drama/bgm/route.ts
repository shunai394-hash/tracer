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
    const tracks: Array<{ name: string; title: string; genre: string; genreLabel: string; url: string }> = [];
    let offset = 0;
    while (tracks.length < MAX_TRACKS) {
      const { data: objects, error } = await storage.list("", {
        limit: Math.min(PAGE_SIZE, MAX_TRACKS - tracks.length),
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw error;
      const page = (objects ?? []).filter((item) => item.name.toLowerCase().endsWith(".mp3"));
      for (const item of page) {
        const metadata = (item.metadata ?? {}) as Record<string, unknown>;
        const filenameGenre = item.name.match(/^(daily|romance|emotional|suspense|comedy|action|uncategorized)--/i)?.[1]?.toLowerCase();
        const genre = GENRES[String(metadata.genre ?? filenameGenre ?? "未分類")] ?? "未分類";
        if (normalizedGenre && normalizedGenre !== "未分類" && genre !== normalizedGenre) continue;
        const { data: signed, error: signedError } = await storage.createSignedUrl(item.name, 60 * 60);
        if (signedError) throw signedError;
        const title = item.name.replace(/^(daily|romance|emotional|suspense|comedy|action|uncategorized)--/i, "").replace(/-[0-9a-f]{8}-[0-9a-f-]{27}\.mp3$/i, "").replace(/\.mp3$/i, "").replace(/-/g, " ");
        tracks.push({
          name: item.name,
          title,
          genre,
          genreLabel: GENRE_LABELS[genre] ?? "未分類",
          url: signed.signedUrl,
        });
        if (tracks.length >= MAX_TRACKS) break;
      }
      if (!objects || objects.length < PAGE_SIZE) break;
      offset += objects.length;
    }
    return json({ ok: true, tracks, truncated: tracks.length >= MAX_TRACKS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[DRAMA BGM LIBRARY FAILED]", detail);
    return json({ ok: false, error: "bgm_library_unavailable", message: "BGMライブラリを取得できません。Storage bucketとサービスロール設定を確認してください。", detail: detail.slice(0, 300) }, 503);
  }
}

export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await request.json() as { action?: string; fileName?: string; size?: number; contentType?: string; genre?: string };
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
