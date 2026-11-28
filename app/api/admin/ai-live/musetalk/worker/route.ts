import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function authorized(request: Request): boolean {
  const expected = process.env.MUSETALK_WORKER_TOKEN ?? "";
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
function allowedOutputUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".supabase.co") && !url.username && !url.password;
  } catch { return false; }
}
export async function POST(request: Request) {
  if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);
  let input: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, error: "invalid_json" }, 400);
    input = value as Record<string, unknown>;
  } catch { return json({ ok: false, error: "invalid_json" }, 400); }

  try {
    const db = createSupabaseAdminClient();
    if (input.action === "claim") {
      const { data, error } = await db.rpc("claim_ai_live_musetalk_job");
      if (error) throw error;
      const job = Array.isArray(data) ? data[0] : null;
      if (!job) return json({ ok: true, job: null });
      return json({ ok: true, job: {
        id: job.id, leaseToken: job.lease_token,
        imageUrl: job.input_image_url, audioUrl: job.input_audio_url,
        attempt: job.attempt_count,
      } });
    }
    if (input.action === "complete") {
      const id = typeof input.id === "string" ? input.id : "";
      const leaseToken = typeof input.leaseToken === "string" ? input.leaseToken : "";
      const succeeded = input.succeeded === true;
      if (!id || !leaseToken || leaseToken.length > 100) return json({ ok: false, error: "invalid_completion" }, 400);
      if (succeeded && !allowedOutputUrl(input.outputUrl)) return json({ ok: false, error: "invalid_output_url" }, 400);
      const update = succeeded
        ? { status: "succeeded", output_video_url: input.outputUrl, error_message: null, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), lease_token: null }
        : { status: "failed", error_message: typeof input.error === "string" ? input.error.slice(0, 1000) : "MuseTalk worker failed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), lease_token: null };
      const { data, error } = await db.from("ai_live_musetalk_jobs").update(update)
        .eq("id", id).eq("lease_token", leaseToken).eq("status", "processing")
        .select("id,status,output_video_url").maybeSingle();
      if (error) throw error;
      if (!data) return json({ ok: false, error: "lease_expired_or_job_missing" }, 409);
      return json({ ok: true, job: data });
    }
    return json({ ok: false, error: "unsupported_action" }, 400);
  } catch {
    return json({ ok: false, error: "worker_queue_unavailable" }, 503);
  }
}
