import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { enqueueMuseRenderJob, manifestAssetsMatch, MUSE_RENDER_BUCKET, validateMuseAssetPaths, validateMuseManifest } from "@/lib/muse/render-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = MUSE_RENDER_BUCKET;
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
export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const id = new URL(request.url).searchParams.get("id");
    const db = createSupabaseAdminClient();
    let query = db.from("ai_live_muse_render_jobs")
      .select("id,status,requested_by,attempt_count,output_video_url,output_path,error_message,created_at,updated_at,completed_at")
      .order("created_at", { ascending: false }).limit(30);
    if (id) query = query.eq("id", id);
    const { data, error } = await query;
    if (error) throw error;
    const storage = db.storage.from(BUCKET);
    const jobs = await Promise.all((data ?? []).map(async (job) => {
      let outputVideoUrl: string | null = null;
      if (job.status === "succeeded" && job.output_path) {
        const { data: signed, error: signError } = await storage.createSignedUrl(job.output_path, 60 * 60);
        if (signError) throw signError;
        outputVideoUrl = signed.signedUrl;
      }
      const { output_path: _outputPath, ...visible } = job;
      return { ...visible, output_video_url: outputVideoUrl };
    }));
    return json({ ok: true, jobs });
  } catch {
    return json({ ok: false, error: "muse_render_queue_unavailable" }, 503);
  }
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

  const requestedBy = typeof body.requestedBy === "string" ? body.requestedBy.trim() : "muse";
  if (!validateMuseManifest(body.manifest) || !validateMuseAssetPaths(body.assetPaths) || !manifestAssetsMatch(body.manifest, body.assetPaths) || !requestedBy || requestedBy.length > 80) {
    return json({ ok: false, error: "invalid_render_job", message: "演出マニフェストまたは素材パスが不正です。" }, 400);
  }
  try {
    const created = await enqueueMuseRenderJob({
      manifest: body.manifest,
      assetPaths: body.assetPaths,
      requestedBy,
    });
    return json({ ok: true, job: created.job, bucket: created.bucket, uploadPaths: created.uploadPaths }, 201);
  } catch {
    return json({ ok: false, error: "muse_render_enqueue_failed", message: "レンダージョブを登録できません。DBマイグレーションを確認してください。" }, 503);
  }
}
