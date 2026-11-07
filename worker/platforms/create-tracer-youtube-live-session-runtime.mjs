import { createTracerYouTubeLiveControl } from "./create-tracer-youtube-live-control.mjs";
import { createTracerYouTubeLiveChatClient } from "./create-tracer-youtube-live-chat-client.mjs";
import { createAiLiveMediaRuntime } from "../media/create-ai-live-media-runtime.mjs";
import { createTracerYouTubeLiveSession } from "./create-tracer-youtube-live-session.mjs";

/**
 * Production composition root for YouTube Live. Deployment supplies a real
 * secret manager: persistStreamSecret stores ingestAddress + streamName and
 * returns an opaque ref; resolveStreamSecret resolves that ref just-in-time
 * to { outputUrl }; deleteStreamSecret removes the stored secret.
 */
export function createTracerYouTubeLiveSessionRuntime({
  baseUrl,
  workerToken,
  persistStreamSecret,
  resolveStreamSecret,
  deleteStreamSecret,
  fetchImpl = fetch,
  speechBridge,
  resolveVideoForProduct,
  mediaRoot,
  ffmpegPath,
  spawnImpl,
  maxRetries,
  baseDelayMs,
  maxDelayMs,
  sleep,
  onError,
  pollIntervalMs,
  activeTimeoutMs,
} = {}) {
  if (typeof persistStreamSecret !== "function" ||
      typeof resolveStreamSecret !== "function" ||
      typeof deleteStreamSecret !== "function") {
    throw new Error("youtube_live_secret_manager_contract_required");
  }
  const broadcastControl = createTracerYouTubeLiveControl({
    baseUrl,
    workerToken,
    persistStreamSecret,
    deleteStreamSecret,
    fetchImpl,
  });
  return createTracerYouTubeLiveSession({
    broadcastControl,
    deleteStreamSecret,
    ...(sleep ? { sleep } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(activeTimeoutMs !== undefined ? { activeTimeoutMs } : {}),
    ...(onError ? { onError } : {}),
    createMediaRuntime: async () => createAiLiveMediaRuntime({
      secretResolver: resolveStreamSecret,
      ...(speechBridge ? { speechBridge } : {}),
      ...(resolveVideoForProduct ? { resolveVideoForProduct } : {}),
      ...(mediaRoot ? { mediaRoot } : {}),
      ...(ffmpegPath ? { ffmpegPath } : {}),
      ...(spawnImpl ? { spawnImpl } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      ...(baseDelayMs !== undefined ? { baseDelayMs } : {}),
      ...(maxDelayMs !== undefined ? { maxDelayMs } : {}),
      ...(sleep ? { sleep } : {}),
    }),
    createChatClient: async ({ onComment, onError: chatError }) =>
      createTracerYouTubeLiveChatClient({
        baseUrl,
        workerToken,
        fetchImpl,
        onComment,
        onError: chatError ?? onError,
      }),
  });
}
