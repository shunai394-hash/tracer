import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SFX_URL = "https://api.elevenlabs.io/v1/sound-generation";
const MODEL_ID = "eleven_text_to_sound_v3";
const OUTPUT_FORMAT = "mp3_44100_128";
const MAX_TEXT_CHARS = 600;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_DURATION_SECONDS = 8;
const PROVIDER_TIMEOUT_MS = 20_000;

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
 * Admin-only, explicitly triggered SFX v3 preview.
 * Duration is deliberately capped at 8 seconds (up to 320 SFX credits at the
 * documented 40 credits/second rate). No retries, background jobs, or auto-play.
 */
export async function POST(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return json({
      ok: false,
      error: "elevenlabs_not_configured",
      message: "Set ELEVENLABS_API_KEY in the server environment. No provider request was sent.",
    }, 503);
  }

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ ok: false, error: "invalid_json_object" }, 400);
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text || text.length > MAX_TEXT_CHARS) {
    return json({ ok: false, error: "text_length_out_of_range", maxCharacters: MAX_TEXT_CHARS }, 400);
  }

  const durationSeconds = typeof input.durationSeconds === "number" ? input.durationSeconds : 6;
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || durationSeconds > MAX_DURATION_SECONDS) {
    return json({
      ok: false,
      error: "duration_out_of_range",
      minSeconds: 0.5,
      maxSeconds: MAX_DURATION_SECONDS,
    }, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(`${SFX_URL}?output_format=${OUTPUT_FORMAT}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        duration_seconds: durationSeconds,
        prompt_influence: 0.7,
        loop: false,
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      // Do not forward provider response bodies; they may contain account diagnostics.
      return json({
        ok: false,
        error: response.status === 429 ? "elevenlabs_rate_limited" : "elevenlabs_request_rejected",
        message: response.status === 404
          ? "SFX v3 may not be enabled for this ElevenLabs account or region."
          : response.status === 429
            ? "ElevenLabs rate limit reached. The request was not retried."
            : "ElevenLabs rejected the SFX request. The response body was not exposed.",
        providerStatus: response.status,
        generationStarted: true,
      }, 502);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
      return json({
        ok: false,
        error: bytes.byteLength === 0 ? "empty_audio_response" : "audio_size_out_of_range",
        message: "The audio response was empty or exceeded the preview size limit. It was not retried.",
        generationStarted: true,
      }, 502);
    }

    const audio = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(audio).set(bytes);
    return new NextResponse(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(bytes.byteLength),
        'Content-Disposition': 'inline; filename="tracer-sfx-v3-preview.mp3"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-AI-SFX-Model": MODEL_ID,
        "X-AI-SFX-Duration": String(durationSeconds),
        "X-AI-SFX-Credits-Cap": String(Math.ceil(durationSeconds * 40)),
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return json({
      ok: false,
      error: timedOut ? "elevenlabs_timeout" : "elevenlabs_unavailable",
      message: timedOut
        ? "SFX generation timed out. The request was not automatically retried."
        : "ElevenLabs could not complete the SFX request. The request was not automatically retried.",
      generationStarted: true,
    }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
