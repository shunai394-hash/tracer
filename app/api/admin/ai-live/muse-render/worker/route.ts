import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabasePublicConfig } from "@/lib/config/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "tracer-muse-render";
const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function authorized(request: Request): boolean {
  const expected = process.env.MUSE_RENDER_WORKER_TOKEN ?? "";
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function POST(request: Request) {
  if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, error: "invalid_json" }, 400);
    body = value as Record<string, unknown>;
  } catch { return json({ ok: false, error: "invalid_json" }, 400); }

  try {
    const db = createSupabaseAdminClient();
    if (body.action === "claim") {
      const { data, error } = await db.rpc("claim_ai_live_muse_render_job");
      if (error) throw error;
      const job = Array.isArray(data) ? data[0] : null;
      if (!job) return json({ ok: true, job: null });
      const storage = db.storage.from(BUCKET);
      const assets = await Promise.all((job.asset_paths as string[]).map(async (path) => {
        const { data: signed, error: signError } = await storage.createSignedUrl(path, 25 * 60);
        if (signError) throw signError;
        return { path: path.split("/").slice(1).join("/"), url: signed.signedUrl };
      }));
      const outputPath = job.id + "/render.mp4";
      const { data: upload, error: uploadError } = await storage.createSignedUploadUrl(outputPath, { upsert: true });
      if (uploadError) throw uploadError;
      const { url } = getSupabasePublicConfig();
      const signedUploadUrl = new URL(upload.signedUrl, url);
      if (!signedUploadUrl.searchParams.has("token")) signedUploadUrl.searchParams.set("token", upload.token);
      return json({ ok: true, job: {
        id: job.id, leaseToken: job.lease_token, attempt: job.attempt_count,
        manifest: job.manifest, assets, output: {
          path: outputPath, url: signedUploadUrl.toString(), token: upload.token,
        },
      } });
    }
    if (body.action === "complete") {
      const id = typeof body.id === "string" ? body.id : "";
      const leaseToken = typeof body.leaseToken === "string" ? body.leaseToken : "";
      const succeeded = body.succeeded === true;
      if (!/^[0-9a-f-]{36}$/i.test(id) || !leaseToken || leaseToken.length > 100) return json({ ok: false, error: "invalid_completion" }, 400);
      const outputPath = id + "/render.mp4";
      const update = succeeded
        ? { status: "succeeded", output_path: outputPath, output_video_url: new URL("/storage/v1/object/public/" + BUCKET + "/" + outputPath, getSupabasePublicConfig().url).toString(), error_message: null, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), lease_token: null }
        : { status: "failed", error_message: typeof body.error === "string" ? body.error.slice(0, 1000) : "Muse renderer failed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), lease_token: null };
      const { data, error } = await db.from("ai_live_muse_render_jobs").update(update)
        .eq("id", id).eq("lease_token", leaseToken).eq("status", "processing")
        .select("id,status,output_video_url").maybeSingle();
      if (error) throw error;
      if (!data) return json({ ok: false, error: "lease_expired_or_job_missing" }, 409);
      return json({ ok: true, job: data });
    }
    return json({ ok: false, error: "unsupported_action" }, 400);
  } catch {
    return json({ ok: false, error: "muse_render_worker_unavailable" }, 503);
  }
}
