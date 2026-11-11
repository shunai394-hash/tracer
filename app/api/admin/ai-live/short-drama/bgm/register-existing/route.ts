import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "tracer-drama-bgm";
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

function validHttpUrl(value: unknown): value is string {
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
    const db = createSupabaseAdminClient();
    const [{ data: objects, error: storageError }, { data: registered, error: ledgerError }] = await Promise.all([
      db.storage.from(BUCKET).list("", { limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
      db.from("ai_live_bgm_rights").select("storage_object"),
    ]);
    if (storageError || ledgerError) throw storageError || ledgerError;
    const known = new Set((registered ?? []).map((row) => row.storage_object));
    const items = (objects ?? [])
      .filter((item) => item.name.toLowerCase().endsWith(".mp3") && !known.has(item.name))
      .map((item) => ({ name: item.name, size: item.metadata?.size ?? null, contentType: item.metadata?.mimetype ?? null, createdAt: item.created_at ?? null }));
    return json({ ok: true, items });
  } catch {
    return json({ ok: false, error: "unregistered_bgm_list_failed" }, 503);
  }
}

export async function POST(request: Request) {
  const authError = await authorize(request);
  if (authError) return authError;
  try {
    const body = await request.json() as Record<string, unknown>;
    const storageObject = typeof body.storageObject === "string" ? body.storageObject.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "";
    const genre = typeof body.genre === "string" ? body.genre : "daily";
    const rightsConfirmed = body.rightsConfirmed === true;
    const attributionRequired = body.attributionRequired === true;
    const attributionText = typeof body.attributionText === "string" ? body.attributionText.trim().slice(0, 1000) : "";
    if (!storageObject || storageObject.includes("/") || !storageObject.toLowerCase().endsWith(".mp3")) {
      return json({ ok: false, error: "invalid_storage_object" }, 400);
    }
    if (!title) return json({ ok: false, error: "title_required" }, 400);
    if (!rightsConfirmed) return json({ ok: false, error: "rights_confirmation_required", message: "配信利用権限の確認が必要です。" }, 400);
    if (!GENRES.has(genre)) return json({ ok: false, error: "invalid_genre" }, 400);
    if (attributionRequired && !attributionText) return json({ ok: false, error: "attribution_text_required" }, 400);

    const db = createSupabaseAdminClient();
    const { data: object, error: objectError } = await db.storage.from(BUCKET).list("", {
      limit: 1000, offset: 0, search: storageObject,
    });
    if (objectError) throw objectError;
    if (!(object ?? []).some((item) => item.name === storageObject)) {
      return json({ ok: false, error: "storage_object_not_found" }, 404);
    }
    const { data, error } = await db.from("ai_live_bgm_rights").insert({
      storage_object: storageObject,
      title,
      composer: "管理者アップロード（権利確認済み）",
      source_url: "admin-upload://local-file",
      license_name: "管理者による配信利用権限確認",
      license_url: "admin-attestation://confirmed",
      license_checked_at: new Date().toISOString(),
      license_scope: "internal_stream",
      commercial_use_allowed: true,
      platform_use_allowed: true,
      redistribution_allowed: false,
      end_user_use_allowed: false,
      attribution_required: attributionRequired,
      attribution_text: attributionRequired ? attributionText : null,
      creator_terms_url: null,
      evidence_note: "管理者が登録時に商用配信およびTRACER内での利用権限を確認。",
      review_status: "approved_internal",
      reviewed_by: "admin-upload-confirmation",
      reviewed_at: new Date().toISOString(),
      genre,
    }).select("id,storage_object,title,genre,review_status").single();
    if (error) {
      if (error.code === "23505") return json({ ok: false, error: "already_registered" }, 409);
      throw error;
    }
    return json({ ok: true, item: data }, 201);
  } catch {
    return json({ ok: false, error: "existing_bgm_registration_failed" }, 503);
  }
}
