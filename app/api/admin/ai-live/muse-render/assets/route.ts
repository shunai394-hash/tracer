import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabasePublicConfig } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "tracer-muse-render";
const MAX_BYTES = 25 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "audio/mpeg": ".mp3",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN ?? "";
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function authorize(request: Request) {
  if (authorizedAdminToken(request)) return null;
  return requireAutomationAuth(request);
}
export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, error: "invalid_json" }, 400);
    body = value as Record<string, unknown>;
  } catch { return json({ ok: false, error: "invalid_json" }, 400); }

  const id = typeof body.jobId === "string" ? body.jobId : "";
  const fileName = typeof body.fileName === "string" ? body.fileName : "";
  const contentType = typeof body.contentType === "string" ? body.contentType.toLowerCase() : "";
  const size = body.size;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Object.hasOwn(TYPES, contentType) ||
      typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES ||
      fileName.length > 120 || /[\\/]/.test(fileName)) {
    return json({ ok: false, error: "invalid_asset", message: "素材形式・容量・ファイル名が不正です。1ファイル25MB以下にしてください。" }, 400);
  }
  try {
    const db = createSupabaseAdminClient();
    const { data: job, error: jobError } = await db.from("ai_live_muse_render_jobs")
      .select("id,status,asset_paths").eq("id", id).maybeSingle();
    if (jobError) throw jobError;
    if (!job || job.status !== "queued") return json({ ok: false, error: "job_not_uploadable" }, 409);
    const ext = TYPES[contentType];
    const safeName = fileName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "asset";
    const path = id + "/" + safeName + ext;
    if (!(job.asset_paths as string[]).includes(path)) return json({ ok: false, error: "asset_not_declared" }, 400);
    const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
    if (error) throw error;
    const { url } = getSupabasePublicConfig();
    const signedUrl = new URL(data.signedUrl, url);
    if (!signedUrl.searchParams.has("token")) signedUrl.searchParams.set("token", data.token);
    return json({ ok: true, upload: { url: signedUrl.toString(), token: data.token, path } }, 201);
  } catch {
    return json({ ok: false, error: "muse_render_asset_upload_prepare_failed" }, 503);
  }
}
