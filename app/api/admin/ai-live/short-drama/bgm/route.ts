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
const GENRES = new Set(["daily", "romance", "emotional", "suspense", "comedy", "action"]);

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

function validHttpUrl(value: FormDataEntryValue | null): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const genre = new URL(request.url).searchParams.get("genre");
    if (genre && !GENRES.has(genre)) {
      return json({ ok: false, error: "invalid_genre" }, 400);
    }

    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from("ai_live_bgm_rights")
      .select("storage_object,title,genre,review_status")
      .eq("review_status", "approved_internal");
    if (genre) query = query.eq("genre", genre);
    const { data: approved, error } = await query
      .order("created_at", { ascending: false })
      .limit(MAX_TRACKS);
    if (error) throw error;

    const storage = supabase.storage.from(BUCKET);
    const tracks = await Promise.all((approved ?? []).map(async (item) => {
      const { data: signed, error: signedError } = await storage.createSignedUrl(item.storage_object, 60 * 60);
      if (signedError) throw signedError;
      return {
        name: item.storage_object,
        title: item.title,
        genre: item.genre,
        reviewStatus: item.review_status,
        url: signed.signedUrl,
      };
    }));

    return json({ ok: true, tracks, truncated: tracks.length >= MAX_TRACKS });
  } catch {
    return json({
      ok: false,
      error: "bgm_library_unavailable",
      message: "承認済みBGMを取得できません。権利台帳とStorage設定を確認してください。",
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

    const title = String(form.get("title") || "").trim().slice(0, 160);
    const composer = String(form.get("composer") || "").trim().slice(0, 160);
    const licenseName = String(form.get("licenseName") || "").trim().slice(0, 160);
    const evidenceNote = String(form.get("evidenceNote") || "").trim().slice(0, 4000);
    const attributionRequired = form.get("attributionRequired") === "true";
    const attributionText = String(form.get("attributionText") || "").trim().slice(0, 1000);
    const creatorTermsUrl = form.get("creatorTermsUrl");
    const genre = String(form.get("genre") || "daily");
    const commercialUseAllowed = form.get("commercialUseAllowed") === "true";
    const platformUseAllowed = form.get("platformUseAllowed") === "true";

    if (!title || !composer || !licenseName || !evidenceNote ||
        !validHttpUrl(form.get("sourceUrl")) || !validHttpUrl(form.get("licenseUrl"))) {
      return json({ ok: false, error: "rights_metadata_required", message: "曲名・作曲者・配布元URL・ライセンス名/URL・確認根拠を入力してください。" }, 400);
    }
    if (!GENRES.has(genre)) return json({ ok: false, error: "invalid_genre" }, 400);
    if (!commercialUseAllowed || !platformUseAllowed) {
      return json({ ok: false, error: "internal_stream_permissions_not_confirmed", message: "商用利用と配信プラットフォーム利用の許可を確認してください。" }, 400);
    }
    if (attributionRequired && !attributionText) {
      return json({ ok: false, error: "attribution_text_required" }, 400);
    }
    if (creatorTermsUrl && !validHttpUrl(creatorTermsUrl)) {
      return json({ ok: false, error: "invalid_creator_terms_url" }, 400);
    }

    const safeBase = file.name.normalize("NFKC")
      .replace(/\\.mp3$/i, "")
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

    const { error: ledgerError } = await supabase.from("ai_live_bgm_rights").insert({
      storage_object: uploadedObject,
      title,
      composer,
      source_url: String(form.get("sourceUrl")).trim(),
      license_name: licenseName,
      license_url: String(form.get("licenseUrl")).trim(),
      license_checked_at: new Date().toISOString(),
      license_scope: "internal_stream",
      commercial_use_allowed: true,
      platform_use_allowed: true,
      redistribution_allowed: false,
      end_user_use_allowed: false,
      attribution_required: attributionRequired,
      attribution_text: attributionRequired ? attributionText : null,
      creator_terms_url: typeof creatorTermsUrl === "string" && creatorTermsUrl.trim() ? creatorTermsUrl.trim() : null,
      evidence_note: evidenceNote,
      review_status: "pending",
      genre,
    });
    if (ledgerError) {
      await supabase.storage.from(BUCKET).remove([uploadedObject]);
      uploadedObject = null;
      throw ledgerError;
    }

    return json({
      ok: true,
      track: { name: uploadedObject, title, genre, reviewStatus: "pending" },
      message: "音源を保存し、権利審査待ちとして登録しました。承認されるまで再生一覧には表示されません。",
    }, 201);
  } catch {
    if (uploadedObject && supabase) {
      await supabase.storage.from(BUCKET).remove([uploadedObject]).catch(() => undefined);
    }
    return json({
      ok: false,
      error: "bgm_upload_failed",
      message: "BGMまたは権利台帳を保存できませんでした。未審査音源は再生対象になりません。",
    }, 503);
  }
}
