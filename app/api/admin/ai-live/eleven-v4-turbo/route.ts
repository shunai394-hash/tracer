import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ELEVEN_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const MODEL_ID = "eleven_v4_turbo";
const MAX_TEXT_CHARS = 1200;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/**
 * Admin-only, explicitly requested Eleven v4 Turbo Japanese voice sample.
 * No browser preview or live comment flow calls this automatically.
 * Keep credentials server-side; never log prompts, voice IDs, or audio.
 */
export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

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
    return json({
      ok: false,
      error: "text_length_out_of_range",
      maxCharacters: MAX_TEXT_CHARS,
    }, 400);
  }

  const voiceId = typeof input.voiceId === "string" ? input.voiceId.trim() : "";
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(voiceId)) {
    return json({
      ok: false,
      error: "valid_voice_id_required",
      message: "Use a voice ID you own or are authorized to use.",
    }, 400);
  }

  // Model and output format are fixed server-side to avoid caller-selected
  // models, formats, or unbounded generation settings.
  const payload = {
    text,
    model_id: MODEL_ID,
    apply_text_normalization: "auto",
  };

  try {
    const upstream = await fetch(
      `${ELEVEN_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(25_000),
      },
    );

    if (!upstream.ok) {
      // Do not expose raw provider response bodies, which can contain account details.
      let providerMessage = "ElevenLabs could not generate this clip.";
      try {
        const errorBody: unknown = await upstream.json();
        if (errorBody && typeof errorBody === "object") {
          const record = errorBody as Record<string, unknown>;
          const detail = record.detail;
          if (typeof detail === "string") providerMessage = detail.slice(0, 300);
          else if (detail && typeof detail === "object") {
            const nested = detail as Record<string, unknown>;
            if (typeof nested.message === "string") providerMessage = nested.message.slice(0, 300);
          }
        }
      } catch {
        // Keep a generic message for non-JSON provider errors.
      }
      return json({
        ok: false,
        error: "elevenlabs_request_failed",
        message: providerMessage,
        generationStarted: false,
      }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("audio/")) {
      return json({ ok: false, error: "unexpected_audio_response" }, 502);
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
        'Content-Disposition': 'inline; filename="tracer-eleven-v4-turbo.mp3"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-AI-Voice-Model": MODEL_ID,
      },
    });
  } catch {
    return json({
      ok: false,
      error: "elevenlabs_unavailable",
      message: "The request failed or timed out. It was not automatically retried.",
    }, 502);
  }
}
