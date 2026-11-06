import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const FISH_MODEL_URL = "https://api.fish.audio/model";
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 105_000;

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.slice(0, 7).toLowerCase() === "bearer " ? authorization.slice(7).trim() : "";
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/**
 * Create a private Fish Audio voice model from an adult speaker's supplied sample.
 * Child voice samples are intentionally not forwarded: Fish Audio's service terms
 * restrict collection of personal information from children under 16.
 */
export async function POST(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    return json({
      ok: false,
      error: "fish_audio_not_configured",
      message: "Set FISH_AUDIO_API_KEY. No audio was uploaded.",
      missing: ["FISH_AUDIO_API_KEY"],
    }, 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: "invalid_multipart_form" }, 400);
  }

  const title = String(form.get("title") ?? "").trim();
  const description = String(form.get("description") ?? "TRACER private drama voice").trim();
  const transcript = String(form.get("transcript") ?? "").trim();
  const speakerType = String(form.get("speakerType") ?? "");
  const rightsConfirmed = form.get("rightsConfirmed") === "true";
  const visibility = String(form.get("visibility") ?? "private");
  const audio = form.get("audio");

  if (speakerType === "child") {
    return json({
      ok: false,
      error: "child_voice_clone_not_supported_by_provider_terms",
      message: "This provider's terms restrict collecting personal information from children under 16. The sample was not uploaded.",
      uploadStarted: false,
    }, 400);
  }
  if (speakerType !== "adult") {
    return json({ ok: false, error: "adult_speaker_confirmation_required", uploadStarted: false }, 400);
  }
  if (!rightsConfirmed) {
    return json({ ok: false, error: "voice_rights_confirmation_required", uploadStarted: false }, 400);
  }
  if (visibility !== "private") {
    return json({ ok: false, error: "private_visibility_required", message: "TRACER voice clones must be private.", uploadStarted: false }, 400);
  }
  if (!title || title.length > 80) {
    return json({ ok: false, error: "invalid_title", maxCharacters: 80 }, 400);
  }
  if (!(audio instanceof File)) {
    return json({ ok: false, error: "audio_file_required" }, 400);
  }
  if (audio.size <= 0 || audio.size > MAX_REFERENCE_BYTES) {
    return json({ ok: false, error: "audio_size_out_of_range", maxBytes: MAX_REFERENCE_BYTES }, 400);
  }
  const allowedTypes = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/webm"]);
  if (audio.type && !allowedTypes.has(audio.type.toLowerCase())) {
    return json({ ok: false, error: "unsupported_audio_type", contentType: audio.type }, 400);
  }

  const payload = new FormData();
  payload.set("type", "tts");
  payload.set("title", title);
  payload.set("description", description.slice(0, 500));
  payload.set("visibility", "private");
  payload.set("train_mode", "fast");
  payload.set("enhance_audio_quality", "true");
  payload.append("voices", audio, audio.name || "reference-audio.wav");
  if (transcript) payload.set("texts", transcript.slice(0, 20_000));
  payload.append("tags", "ja");
  payload.append("tags", "tracer-drama");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(FISH_MODEL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: payload,
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return json({
        ok: false,
        error: "fish_audio_model_creation_rejected",
        providerStatus: response.status,
        message: "Fish Audio rejected the private model request. No automatic retry was made.",
        uploadStarted: true,
      }, 502);
    }

    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return json({ ok: false, error: "invalid_fish_audio_model_response", uploadStarted: true }, 502);
    }
    const model = result as Record<string, unknown>;
    const modelId = typeof model._id === "string" ? model._id : typeof model.id === "string" ? model.id : "";
    if (!modelId) {
      return json({ ok: false, error: "fish_audio_model_id_missing", uploadStarted: true }, 502);
    }

    return json({
      ok: true,
      modelId,
      title: typeof model.title === "string" ? model.title : title,
      state: typeof model.state === "string" ? model.state : "created",
      visibility: "private",
      nextStep: "Register this modelId as a consent-confirmed custom voice in TRACER.",
    }, 201);
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error && error.name === "AbortError" ? "fish_audio_model_creation_timeout" : "fish_audio_unavailable",
      message: "Fish Audio could not complete the request. It was not automatically retried.",
      uploadStarted: true,
    }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
