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
    const storage = createSupabaseAdminClient().storage.from(BUCKET);
    const requestedGenre = new URL(request.url).searchParams.get("genre");
    const normalizedGenre = requestedGenre ? (GENRES[requestedGenre] ?? requestedGenre) : undefined;
    const objects: Array<{ name: string; created_at?: string | null }> = [];
    for (let offset = 0; offset < MAX_TRACKS; offset += PAGE_SIZE) {
      const { data: page, error } = await storage.list("", {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw error;
      objects.push(...(page ?? []));
      if (!page || page.length < PAGE_SIZE) break;
    }
    const mp3s = objects.filter((item) => item.name.toLowerCase().endsWith(".mp3"));
    const tracks = (await Promise.all(mp3s.map(async (item) => {
      const [prefix, ...rest] = item.name.split("--");
      const genre = GENRE_LABELS[prefix] ? prefix : "未分類";
      if (normalizedGenre && normalizedGenre !== "未分類" && genre !== normalizedGenre) return null;
      const encodedTitle = rest.length >= 2 ? rest[0] : "";
      let title = "";
      if (/^[A-Za-z0-9_-]+$/.test(encodedTitle)) {
        try { title = Buffer.from(encodedTitle, "base64url").toString("utf8"); } catch { title = ""; }
      }
      if (!title) {
        const base = rest.join("--").replace(/\.mp3$/i, "").replace(/-[0-9a-f]{8}-[0-9a-f-]{27}$/i, "");
        title = base.replace(/-/g, " ") || item.name;
      }
      const { data: signed, error: signedError } = await storage.createSignedUrl(item.name, 60 * 60);
      if (signedError) throw signedError;
      return { name: item.name, title, genre, genreLabel: GENRE_LABELS[genre] ?? "未分類", url: signed.signedUrl, createdAt: item.created_at ?? null };
    }))).filter((track): track is NonNullable<typeof track> => track !== null);
    tracks.sort((a, b) => a.title.localeCompare(b.title, "ja"));
    return json({ ok: true, tracks, truncated: objects.length >= MAX_TRACKS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[DRAMA BGM LIBRARY FAILED]", detail);
    return json({ ok: false, error: "bgm_library_unavailable", message: "BGMライブラリを取得できません。Storage設定を確認してください。", detail: detail.slice(0, 300) }, 503);
  }
}
export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const body = await request.json() as { action?: string; fileName?: string; size?: number; contentType?: string; genre?: string };
    if (body.action !== "prepare") return json({ ok: false, error: "unsupported_action" }, 400);
    const fileName = String(body.fileName ?? "").trim();
    const size = Number(body.size ?? 0);
    const mimeType = String(body.contentType ?? "").toLowerCase();
    if (!fileName.toLowerCase().endsWith(".mp3") || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
      return json({ ok: false, error: "audio_file_size_or_name_invalid", message: "MP3は1曲10MB以下にしてください。", maxBytes: MAX_FILE_BYTES }, 400);
    }
    if (mimeType && !ALLOWED_TYPES.has(mimeType)) return json({ ok: false, error: "mp3_only", message: "MP3形式のファイルを選択してください。" }, 415);
    const requestedGenre = String(body.genre || "未分類");
    const genre = GENRES[requestedGenre] ?? "未分類";
    const displayTitle = fileName.normalize("NFKC").replace(/\.mp3$/i, "").trim() || "bgm";
    // Supabase Storage object keys must be ASCII-safe. Keep the original title
    // as UTF-8 base64url (up to 96 bytes) so Japanese names remain readable in
    // the library while the actual object key contains only URL-safe characters.
    const titleBytes = Buffer.from(displayTitle, "utf8");
    let titleByteLength = Math.min(titleBytes.length, 96);
    while (titleByteLength > 0 && (titleBytes[titleByteLength] & 0xc0) === 0x80) titleByteLength--;
    const encodedTitle = titleBytes.subarray(0, titleByteLength).toString("base64url") || "bgm";
    const genrePrefix = genre === "未分類" ? "uncategorized" : genre;
    const objectName = genrePrefix + "--" + encodedTitle + "--" + randomUUID() + ".mp3";
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(objectName, { upsert: false });
    if (error) throw error;
    const { url } = getSupabasePublicConfig();
    const uploadUrl = new URL(data.signedUrl, url).toString();
    console.info("[DRAMA BGM SIGNED UPLOAD CREATED]", { object: objectName, bytes: size, genre });
    return json({ ok: true, upload: { url: uploadUrl, token: data.token, path: data.path }, track: { name: objectName, title: displayTitle, genre, genreLabel: GENRE_LABELS[genre] ?? "未分類" } }, 201);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[DRAMA BGM UPLOAD PREPARE FAILED]", { detail });
    return json({ ok: false, error: "bgm_upload_prepare_failed", message: "Storageへのアップロード準備に失敗しました。", detail: detail.slice(0, 300) }, 503);
  }
}
