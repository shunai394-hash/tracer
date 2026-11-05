import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { listLicensedJapaneseVoices } from "@/lib/ai-live/fish-audio-public-voices";
import { isConsentedCustomJapaneseVoice } from "@/lib/ai-live/fish-audio-consented-custom-voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const MAX_TEXT_CHARS = 1200;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 25_000;

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

async function readBoundedAudio(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw new Error("audio_size_limit_exceeded");
  if (!response.body) throw new Error("empty_audio_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AUDIO_BYTES) {
        await reader.cancel();
        throw new Error("audio_size_limit_exceeded");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error("empty_audio_response");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** One-shot, admin-only Fish Audio preview. No retries and no automatic publishing. */
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
      message: "Set FISH_AUDIO_API_KEY. No provider request was sent.",
      missing: ["FISH_AUDIO_API_KEY"],
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
  const referenceId = typeof input.referenceId === "string" ? input.referenceId.trim() : "";
  const speed = typeof input.prosody === "object" && input.prosody !== null && !Array.isArray(input.prosody)
    ? (input.prosody as Record<string, unknown>).speed
    : undefined;
  const prosodySpeed = typeof speed === "number" && Number.isFinite(speed) ? speed : 1;
  if (prosodySpeed < 0.5 || prosodySpeed > 2) {
    return json({ ok: false, error: "prosody_speed_out_of_range", message: "Speaking speed must be between 0.5 and 2." }, 400);
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(referenceId)) {
    return json({ ok: false, error: "licensed_japanese_voice_required", message: "Choose a voice from the licensed Japanese voice list." }, 400);
  }
  if (!text || text.length > MAX_TEXT_CHARS) {
    return json({ ok: false, error: "text_length_out_of_range", maxCharacters: MAX_TEXT_CHARS }, 400);
  }

  const isCustomVoice = isConsentedCustomJapaneseVoice(referenceId);
  if (!isCustomVoice) {
    let licensedVoices;
    try {
      licensedVoices = await listLicensedJapaneseVoices(apiKey);
    } catch {
      return json({ ok: false, error: "fish_audio_voice_library_unavailable", message: "The selected public voice could not be verified. No TTS generation was requested." }, 502);
    }
    if (!licensedVoices.some((voice) => voice.id === referenceId)) {
      return json({ ok: false, error: "voice_not_in_licensed_japanese_library", message: "Choose a currently licensed public Japanese voice or a consent-confirmed registered custom voice." }, 400);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        model: process.env.FISH_AUDIO_MODEL || "s2.1-pro-free",
      },
      body: JSON.stringify({ text, reference_id: referenceId, format: "mp3", prosody: { speed: prosodySpeed } }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      // Do not forward provider response bodies: they may contain submitted text or identifiers.
      return json({
        ok: false,
        error: "fish_audio_request_rejected",
        providerStatus: response.status,
        message: "Fish Audio rejected the request. Check model access and API permissions. It was not automatically retried.",
        generationStarted: true,
      }, 502);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("audio/") && !contentType.toLowerCase().includes("application/octet-stream")) {
      return json({ ok: false, error: "unexpected_provider_content_type", generationStarted: true }, 502);
    }

    const bytes = await readBoundedAudio(response);
    const output = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(output).set(bytes);
    return new NextResponse(output, {
      status: 200,
      headers: {
        "Content-Type": contentType.toLowerCase().includes("audio/") ? contentType : "audio/mpeg",
        "Content-Length": String(bytes.byteLength),
        'Content-Disposition': 'inline; filename="tracer-fish-audio-preview.mp3"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-AI-Voice-Provider": "fish-audio",
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    return json({
      ok: false,
      error: reason === "audio_size_limit_exceeded"
        ? "audio_size_out_of_range"
        : reason === "empty_audio_response"
          ? "empty_audio_response"
          : reason === "AbortError"
            ? "fish_audio_timeout"
            : "fish_audio_unavailable",
      message: "Fish Audio could not complete the request. It was not automatically retried.",
      generationStarted: true,
    }, 502);
  } finally {
    clearTimeout(timeout);
  }
}
