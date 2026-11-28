import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "tracer-muse-render";
const PRESETS = new Set(["fade-up", "soft-zoom", "slide-left", "pop", "fade"]);
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
function validateManifest(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (m.format !== "muse-motion-manifest" || m.version !== 1 || !Array.isArray(m.scenes) || m.scenes.length < 1 || m.scenes.length > 120) return false;
  let total = 0;
  for (const scene of m.scenes) {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) return false;
    const s = scene as Record<string, unknown>;
    const d = s.durationSeconds;
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0.5 || d > 60 || typeof s.motionPreset !== "string" || !PRESETS.has(s.motionPreset)) return false;
    if (typeof s.title !== "string" || s.title.length > 120 || typeof s.text !== "string" || s.text.length > 500) return false;
    total += d;
  }
  return total <= 900;
}
function validAssetPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 122 && value.every((p) =>
    typeof p === "string" && p.length <= 240 && /^[a-zA-Z0-9][a-zA-Z0-9/_-]*\\.(mp3|png|jpg|jpeg|webp)$/i.test(p) &&
    !p.includes("..") && !p.startsWith("/") && !p.includes("//")
  );
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
  if (!validateManifest(body.manifest) || !validAssetPaths(body.assetPaths) || !requestedBy || requestedBy.length > 80) {
    return json({ ok: false, error: "invalid_render_job", message: "演出マニフェストまたは素材パスが不正です。" }, 400);
  }
  try {
    const db = createSupabaseAdminClient();
    const id = randomUUID();
    const paths = body.assetPaths as string[];
    const { data, error } = await db.from("ai_live_muse_render_jobs").insert({
      id, manifest: body.manifest, asset_paths: paths.map((p) => id + "/" + p), requested_by: requestedBy,
    }).select("id,status,requested_by,created_at").single();
    if (error) throw error;
    return json({ ok: true, job: data, bucket: BUCKET, uploadPaths: paths.map((p) => id + "/" + p) }, 201);
  } catch {
    return json({ ok: false, error: "muse_render_enqueue_failed", message: "レンダージョブを登録できません。DBマイグレーションを確認してください。" }, 503);
  }
}
