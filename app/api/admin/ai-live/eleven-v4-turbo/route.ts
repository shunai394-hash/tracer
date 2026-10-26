import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ELEVEN_TTD_WS_URL = "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input";
const MODEL_ID = "eleven_v4_turbo";
const OUTPUT_FORMAT = "mp3_44100_128";
const MAX_TEXT_CHARS = 1200;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 25_000;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function synthesizeDialogue(apiKey: string, voiceId: string, text: string): Promise<Uint8Array> {
  const url = new URL(ELEVEN_TTD_WS_URL);
  url.searchParams.set("model_id", MODEL_ID);
  url.searchParams.set("output_format", OUTPUT_FORMAT);

  return await new Promise<Uint8Array>((resolve, reject) => {
    const socket = new WebSocket(url);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      } catch {
        // Ignore close errors after the result has been settled.
      }
      if (error) {
        reject(error);
      } else {
        resolve(new Uint8Array(Buffer.concat(chunks, totalBytes)));
      }
    };

    const timeout = setTimeout(() => finish(new Error("provider_timeout")), PROVIDER_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      // v4 Turbo is only supported by Text to Dialogue WebSocket. Register
      // exactly one authorized voice, then submit the short clip and flush.
      socket.send(JSON.stringify({ voices: [voiceId], xi_api_key: apiKey }));
      socket.send(JSON.stringify({
        inputs: [{ text, voice_id: voiceId, new_turn: true }],
      }));
      socket.send(JSON.stringify({ close_socket: true }));
    });

    socket.addEventListener("message", async (event: MessageEvent) => {
      try {
        const raw = typeof event.data === "string"
          ? event.data
          : await (event.data as Blob).text();
        const message: unknown = JSON.parse(raw);
        if (!message || typeof message !== "object") return;
        const record = message as Record<string, unknown>;

        if (record.error) {
          finish(new Error("provider_rejected_request"));
          return;
        }

        if (typeof record.audio === "string") {
          const chunk = Buffer.from(record.audio, "base64");
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_AUDIO_BYTES) {
            finish(new Error("audio_size_limit_exceeded"));
            return;
          }
          chunks.push(chunk);
        }

        if (record.is_final === true) {
          if (totalBytes === 0) {
            finish(new Error("empty_audio_response"));
          } else {
            finish();
          }
        }
      } catch {
        finish(new Error("invalid_provider_message"));
      }
    });

    socket.addEventListener("error", () => finish(new Error("websocket_error")));
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("connection_closed_before_final_audio"));
    });
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

  try {
    const bytes = await synthesizeDialogue(apiKey, voiceId, text);
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const status = reason === "provider_rejected_request" ? 502 : 502;
    return json({
      ok: false,
      error: reason === "provider_timeout"
        ? "elevenlabs_timeout"
        : reason === "audio_size_limit_exceeded"
          ? "audio_size_out_of_range"
          : "elevenlabs_unavailable",
      message: reason === "provider_timeout"
        ? "The request timed out. It was not automatically retried."
        : "ElevenLabs could not complete the audio request. It was not automatically retried.",
      generationStarted: true,
    }, status);
  }
}
