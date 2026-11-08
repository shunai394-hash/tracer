import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const db = createSupabaseAdminClient();
    const { data, error } = await db
      .from("ai_live_bgm_rights")
      .select("id,storage_object,title,composer,source_url,license_name,license_url,license_checked_at,license_scope,commercial_use_allowed,platform_use_allowed,redistribution_allowed,end_user_use_allowed,attribution_required,attribution_text,creator_terms_url,evidence_note,review_status,reviewed_by,reviewed_at,genre,created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return json({ ok: true, items: data ?? [] });
  } catch {
    return json({ ok: false, error: "bgm_review_list_failed" }, 503);
  }
}

export async function PATCH(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const status = body.status;
    const reviewer = typeof body.reviewer === "string" ? body.reviewer.trim().slice(0, 120) : "";
    if (!id || !reviewer || (status !== "approved_internal" && status !== "rejected")) {
      return json({ ok: false, error: "invalid_review_request" }, 400);
    }

    const db = createSupabaseAdminClient();
    const { data, error } = await db
      .from("ai_live_bgm_rights")
      .update({
        review_status: status,
        reviewed_by: reviewer,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("review_status", "pending")
      .select("id,review_status,reviewed_by,reviewed_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) return json({ ok: false, error: "pending_track_not_found_or_already_reviewed" }, 409);
    return json({ ok: true, item: data });
  } catch {
    return json({ ok: false, error: "bgm_review_update_failed" }, 503);
  }
}
