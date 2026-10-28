import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const MAX_TEXT_CHARS = 1200;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

function authorizedAdminToken(request: Request): boolean {
  const expected = process.env.TRACER_ADMIN_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "") ?? "";
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

async function readAudioBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const fail = (code: "audio_size_out_of_range" | "audio_read_failed"): Error => {
    const error = new Error(code);
    error.name = "AudioBodyError";
    return error;
  };

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw fail("audio_read_failed");
  }

  const rawLength = response.headers.get("content-length");
  const trimmedLength = rawLength === null ? "" : rawLength.trim();
  // Only a non-negative decimal integer is a declared length. Exponents, fractions,
  // signs, and other forms are ignored so the measured stream enforces the cap.
  if (/^\d+$/.test(trimmedLength)) {
    const digits = trimmedLength.replace(/^0+/, "") || "0";
    const limit = String(maxBytes);
    const declaredExceedsLimit =
      digits.length > limit.length ||
      (digits.length === limit.length && digits > limit);
    if (declaredExceedsLimit) {
      const unread = response.body;
      if (unread) {
        try {
          await unread.cancel();
        } catch {
          // The body was not read. Size rejection still applies.
        }
      }
      throw fail("audio_size_out_of_range");
    }
  }

  const body = response.body;
  if (!body) {
    throw fail("audio_size_out_of_range");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    throw fail("audio_read_failed");
  }

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        throw fail("audio_read_failed");
      }
      if (next.done) break;
      const value = next.value;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - total) {
        throw fail("audio_size_out_of_range");
      }
      const owned = new Uint8Array(value.byteLength);
      owned.set(value);
      chunks.push(owned);
      total += owned.byteLength;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Keep the original size or read failure.
    }
    if (error instanceof Error && error.name === "AudioBodyError") throw error;
    throw fail("audio_read_failed");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel() already released the reader.
    }
  }

  if (total === 0) {
    throw fail("audio_size_out_of_range");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Admin-only Drama 3 speech synthesis for short, explicitly requested clips.
 * This is opt-in and never called automatically by the browser preview.
 * Keep the Fish API key server-side; do not log text, voice IDs, or audio.
 */
export async function POST(request: Request) {
  if (!authorizedAdminToken(request)) {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;
  }

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

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await readAudioBodyLimited(upstream, MAX_AUDIO_BYTES);
    } catch (error) {
      if (error instanceof Error && error.name === "AudioBodyError" && error.message === "audio_size_out_of_range") {
        return json({ ok: false, error: "audio_size_out_of_range" }, 502);
      }
      throw error;
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
