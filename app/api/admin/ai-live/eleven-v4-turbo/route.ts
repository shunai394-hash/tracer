import { timingSafeEqual } from "node:crypto";
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

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new Error("unsupported_provider_message");
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
      // v4 Turbo allows exactly one registered voice per dialogue session.
      socket.send(JSON.stringify({ voices: [voiceId], xi_api_key: apiKey }));
      socket.send(JSON.stringify({
        inputs: [{ text, voice_id: voiceId, new_turn: true }],
      }));
      // Flush buffered text and signal the end of this one-shot session.
      socket.send(JSON.stringify({ close_socket: true }));
    });

    socket.addEventListener("message", async (event: MessageEvent) => {
      try {
        const raw = await messageText(event.data);
        const message: unknown = JSON.parse(raw);
        if (!message || typeof message !== "object") return;
        const record = message as Record<string, unknown>;

        if (record.error) {
          const providerError = record.error;
          let providerCode = "";
          let providerMessage = "";
          if (typeof providerError === "string") {
            providerMessage = providerError;
          } else if (providerError && typeof providerError === "object") {
            const details = providerError as Record<string, unknown>;
            providerCode = typeof details.code === "string" || typeof details.code === "number"
              ? String(details.code)
              : typeof details.status === "string" || typeof details.status === "number"
                ? String(details.status)
                : "";
            providerMessage = typeof details.message === "string"
              ? details.message
              : typeof details.detail === "string"
                ? details.detail
                : "";
          }
          // Keep provider diagnostics useful without ever returning credentials,
          // the submitted script, or the voice identifier to the browser.
          const safeMessage = providerMessage
            .replaceAll(apiKey, "[redacted]")
            .replaceAll(voiceId, "[voice]")
            .replaceAll(text, "[text]")
            .replace(/[\\r\\n\\t]+/gu, " ")
            .slice(0, 180);
          const error = new Error("provider_rejected_request");
          Object.assign(error, {
            providerCode: providerCode.replace(/[^a-zA-Z0-9_.:-]/gu, "").slice(0, 48),
            providerMessage: safeMessage,
          });
          finish(error);
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

        // ElevenLabs documents both final-marker shapes across the TTD
        // guide and API reference. Accept either to avoid rejecting valid audio.
        if (record.is_final === true || record.is_final_audio_for_turn === true) {
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
      if (!settled) {
        finish(new Error(totalBytes > 0 ? "final_audio_marker_missing" : "connection_closed_before_final_audio"));
      }
    });
  });
}

/**
 * Admin-only Eleven v4 Turbo speech for one explicitly requested clip.
 * The browser preview calls this only when an operator presses Generate.
 * GitHub OIDC and CRON_SECRET stay valid; TRACER_ADMIN_TOKEN is an additional admin path.
 * Keep the API key server-side; never log prompts, voice IDs, tokens, or audio.
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
    if (bytes.byteLength === 0) {
      return json({
        ok: false,
        error: "empty_audio_response",
        message: "ElevenLabs returned no audio. It was not automatically retried.",
        generationStarted: true,
      }, 502);
    }
    const responseBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(responseBuffer).set(bytes);
    return new NextResponse(responseBuffer, {
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
    const providerDiagnostic = error && typeof error === "object"
      ? error as Error & { providerCode?: string; providerMessage?: string }
      : null;
    const errorCode = reason === "provider_timeout"
      ? "elevenlabs_timeout"
      : reason === "empty_audio_response"
        ? "empty_audio_response"
        : reason === "audio_size_limit_exceeded"
          ? "audio_size_out_of_range"
          : reason === "provider_rejected_request"
            ? "elevenlabs_request_rejected"
            : "elevenlabs_unavailable";
    const message = reason === "provider_timeout"
      ? "The request timed out. It was not automatically retried."
      : reason === "empty_audio_response"
        ? "ElevenLabs returned no audio. It was not automatically retried."
        : reason === "provider_rejected_request"
          ? "ElevenLabs rejected the request. Check the API key permissions and whether the voice is available to this account. It was not automatically retried."
          : "ElevenLabs could not complete the audio request. It was not automatically retried.";
    return json({
      ok: false,
      error: errorCode,
      message,
      ...(reason === "provider_rejected_request" && (providerDiagnostic?.providerCode || providerDiagnostic?.providerMessage)
        ? {
            providerDiagnostic: {
              ...(providerDiagnostic.providerCode ? { code: providerDiagnostic.providerCode } : {}),
              ...(providerDiagnostic.providerMessage ? { message: providerDiagnostic.providerMessage } : {}),
            },
          }
        : {}),
      generationStarted: true,
    }, 502);
  }
}
