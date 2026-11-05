import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const BUCKET = "tracer-drama-bgm";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["audio/mpeg", "audio/mp3"]);

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
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.storage.from(BUCKET).list("", { limit: 100, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;
    const tracks = await Promise.all((data ?? []).filter((item) => item.name.toLowerCase().endsWith(".mp3")).map(async (item) => {
      const { data: signed, error: signedError } = await supabase.storage.from(BUCKET).createSignedUrl(item.name, 60 * 60);
      if (signedError) throw signedError;
      return { name: item.name, title: item.name.replace(/\.mp3$/i, ""), genre: typeof item.metadata?.genre === "string" ? item.metadata.genre : "未分類", url: signed.signedUrl };
    }));
    return json({ ok: true, tracks });
  } catch {
    return json({ ok: false, error: "bgm_library_unavailable", message: "BGMライブラリを取得できません。Storage bucketとサービスロール設定を確認してください。" }, 503);
  }
}

export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ ok: false, error: "audio_file_required" }, 400);
    if (file.size < 1 || file.size > MAX_FILE_BYTES) return json({ ok: false, error: "audio_file_size_out_of_range", maxBytes: MAX_FILE_BYTES }, 413);
    if (!ALLOWED_TYPES.has(file.type.toLowerCase()) || !file.name.toLowerCase().endsWith(".mp3")) {
      return json({ ok: false, error: "mp3_only" }, 415);
    }
    const safeBase = file.name.normalize("NFKC").replace(/\.mp3$/i, "").replace(/[^a-zA-Z0-9ぁ-んァ-ヶ一-龠_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "bgm";
    const objectName = safeBase + "-" + crypto.randomUUID() + ".mp3";
    const bytes = new Uint8Array(await file.arrayBuffer());
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.storage.from(BUCKET).upload(objectName, bytes, { contentType: "audio/mpeg", upsert: false, metadata: { genre: String(form.get("genre") || "未分類").slice(0, 40) } });
    if (error) throw error;
    const { data: signed, error: signedError } = await supabase.storage.from(BUCKET).createSignedUrl(objectName, 60 * 60);
    if (signedError) throw signedError;
    return json({ ok: true, track: { name: objectName, title: safeBase, url: signed.signedUrl } }, 201);
  } catch {
    return json({ ok: false, error: "bgm_upload_failed", message: "BGMを保存できませんでした。Supabase Storage設定を確認してください。" }, 503);
  }
}
