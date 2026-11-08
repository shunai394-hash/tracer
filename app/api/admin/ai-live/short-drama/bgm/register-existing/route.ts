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
    const composer = typeof body.composer === "string" ? body.composer.trim().slice(0, 160) : "";
    const licenseName = typeof body.licenseName === "string" ? body.licenseName.trim().slice(0, 160) : "";
    const evidenceNote = typeof body.evidenceNote === "string" ? body.evidenceNote.trim().slice(0, 4000) : "";
    const genre = typeof body.genre === "string" ? body.genre : "daily";
    const attributionRequired = body.attributionRequired === true;
    const attributionText = typeof body.attributionText === "string" ? body.attributionText.trim().slice(0, 1000) : "";
    if (!storageObject || storageObject.includes("/") || !storageObject.toLowerCase().endsWith(".mp3")) {
      return json({ ok: false, error: "invalid_storage_object" }, 400);
    }
    if (!title || !composer || !licenseName || !evidenceNote ||
        !validHttpUrl(body.sourceUrl) || !validHttpUrl(body.licenseUrl) ||
        (body.creatorTermsUrl && !validHttpUrl(body.creatorTermsUrl))) {
      return json({ ok: false, error: "rights_metadata_required" }, 400);
    }
    if (body.commercialUseAllowed !== true || body.platformUseAllowed !== true) {
      return json({ ok: false, error: "internal_stream_permissions_not_confirmed" }, 400);
    }
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
      composer,
      source_url: String(body.sourceUrl).trim(),
      license_name: licenseName,
      license_url: String(body.licenseUrl).trim(),
      license_checked_at: new Date().toISOString(),
      license_scope: "internal_stream",
      commercial_use_allowed: true,
      platform_use_allowed: true,
      redistribution_allowed: false,
      end_user_use_allowed: false,
      attribution_required: attributionRequired,
      attribution_text: attributionRequired ? attributionText : null,
      creator_terms_url: typeof body.creatorTermsUrl === "string" && body.creatorTermsUrl.trim() ? body.creatorTermsUrl.trim() : null,
      evidence_note: evidenceNote,
      review_status: "pending",
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
