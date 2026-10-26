import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const MAX_TEXT_CHARS = 1200;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/**
 * Admin-only Drama 3 speech synthesis for short, explicitly requested clips.
 * This is opt-in and never called automatically by the browser preview.
 * Keep the Fish API key server-side; do not log text, voice IDs, or audio.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) {
    return json({
      ok: false,
      error: "fish_audio_not_configured",
      message: "Set FISH_API_KEY in the server environment. No provider request was sent.",
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
    return json({
      ok: false,
      error: "text_length_out_of_range",
      maxCharacters: MAX_TEXT_CHARS,
    }, 400);
  }

  const referenceId = typeof input.referenceId === "string"
    ? input.referenceId.trim()
    : "";
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(referenceId)) {
    return json({
      ok: false,
      error: "valid_reference_id_required",
      message: "Use a voice/reference ID you own or are authorized to use.",
    }, 400);
  }

  // Explicitly reject unbounded or caller-selected models; this endpoint only
  // uses Drama 3 and does not retry, clone voices, or fall back to paid models.
  const payload = {
    text,
    reference_id: referenceId,
    format: "mp3",
  };

  try {
    const upstream = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model: "drama-3",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      let providerCode = "fish_audio_request_failed";
      let providerMessage = "Fish Audio could not generate this clip.";
      try {
        const errorBody: unknown = await upstream.json();
        if (errorBody && typeof errorBody === "object") {
          const record = errorBody as Record<string, unknown>;
          if (typeof record.code === "string") providerCode = record.code.slice(0, 100);
          if (typeof record.message === "string") providerMessage = record.message.slice(0, 300);
          if (typeof record.detail === "string") providerMessage = record.detail.slice(0, 300);
        }
      } catch {
        // Do not surface raw provider response bodies.
      }
      return json({
        ok: false,
        error: providerCode,
        message: providerMessage,
        generationStarted: false,
      }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("audio/")) {
      return json({
        ok: false,
        error: "unexpected_audio_response",
        message: "Fish Audio returned an unexpected response type.",
      }, 502);
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
      return json({ ok: false, error: "audio_size_out_of_range" }, 502);
    }

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": 'inline; filename="tracer-drama-3.mp3"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-AI-Voice-Model": "drama-3",
      },
    });
  } catch {
    return json({
      ok: false,
      error: "fish_audio_unavailable",
      message: "The request failed or timed out. It was not automatically retried.",
    }, 502);
  }
}
