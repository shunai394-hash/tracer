const DEFAULT_MAX_AUDIO_BYTES = 12 * 1024 * 1024;

async function readBytesLimited(response, maxBytes) {
  const rawLength = response.headers.get("content-length");
  if (rawLength && /^\d+$/.test(rawLength.trim()) && Number(rawLength) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, error: "audio_too_large" };
  }
  if (!response.body) return { ok: false, error: "empty_audio" };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > maxBytes - total) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: "audio_too_large" };
      }
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
      total += copy.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, error: "audio_read_failed" };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (!total) return { ok: false, error: "empty_audio" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * Calls TRACER's existing protected comment->verified-facts->Fish Audio route.
 * The worker never constructs product claims or contacts Fish Audio directly.
 */
export function createTracerspeechBridge({
  baseUrl = process.env.TRACER_BASE_URL,
  token = process.env.TRACER_AUTOMATION_TOKEN,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
} = {}) {
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
    throw new Error("TRACER_BASE_URL must be an HTTPS URL");
  }
  if (!token || token.length < 24) {
    throw new Error("TRACER_AUTOMATION_TOKEN is required");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!Number.isInteger(maxAudioBytes) || maxAudioBytes < 1 || maxAudioBytes > DEFAULT_MAX_AUDIO_BYTES) {
    throw new Error("maxAudioBytes is out of range");
  }

  const endpoint = new URL("/api/admin/ai-live/speak-reply", baseUrl).toString();

  return {
    async synthesize({ comment, productId }) {
      if (typeof comment !== "string" || !comment.trim() || comment.length > 2000) {
        return { status: "rejected", reason: "invalid_comment" };
      }
      if (typeof productId !== "string" || !productId.trim() || productId.length > 128) {
        return { status: "rejected", reason: "invalid_product_context" };
      }

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
            accept: "audio/mpeg, application/json",
          },
          body: JSON.stringify({ comment, productId }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch {
        return { status: "failed", reason: "speech_service_unavailable" };
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/json")) {
        let payload;
        try { payload = await response.json(); } catch {
          return { status: "failed", reason: "invalid_speech_service_response" };
        }
        if (!response.ok) return { status: "failed", reason: "speech_service_rejected" };
        if (payload?.ok === true && payload?.spoken === false) {
          return {
            status: "handoff",
            reason: typeof payload.reason === "string" ? payload.reason : "human_handoff",
          };
        }
        return { status: "failed", reason: "unexpected_speech_service_response" };
      }

      if (!response.ok || !contentType.startsWith("audio/mpeg")) {
        await response.body?.cancel().catch(() => {});
        return { status: "failed", reason: "speech_audio_unavailable" };
      }
      const audio = await readBytesLimited(response, maxAudioBytes);
      if (!audio.ok) return { status: "failed", reason: audio.error };
      return {
        status: "spoken_audio",
        mimeType: "audio/mpeg",
        audio: audio.bytes,
      };
    },
  };
}

export function createCommentSpeechPipeline({ bridge, deduplicator, onAudio }) {
  if (!bridge || typeof bridge.synthesize !== "function") throw new Error("speech bridge is required");
  if (!deduplicator || typeof deduplicator.accept !== "function") throw new Error("comment deduplicator is required");
  if (typeof onAudio !== "function") throw new Error("audio output callback is required");

  return {
    async handle({ event, productId }) {
      if (!event || typeof event.id !== "string" || typeof event.text !== "string") {
        return { status: "rejected", reason: "invalid_normalized_event" };
      }
      if (!deduplicator.accept(event)) return { status: "duplicate" };
      const result = await bridge.synthesize({ comment: event.text, productId });
      if (result.status !== "spoken_audio") return result;
      try {
        await onAudio({ eventId: event.id, productId, mimeType: result.mimeType, audio: result.audio });
      } catch {
        return { status: "failed", reason: "audio_output_unavailable" };
      }
      return { status: "queued_audio", eventId: event.id };
    },
  };
}
