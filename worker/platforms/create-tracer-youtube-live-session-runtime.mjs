import { createTracerYouTubeLiveControl } from "./create-tracer-youtube-live-control.mjs";
import { createTracerYouTubeLiveChatClient } from "./create-tracer-youtube-live-chat-client.mjs";
import { createAiLiveMediaRuntime } from "../media/create-ai-live-media-runtime.mjs";
import { createTracerYouTubeLiveSession } from "./create-tracer-youtube-live-session.mjs";
import { createSupabaseYouTubeStreamSecretStore } from "./supabase-youtube-stream-secret-store.mjs";

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
  supabaseUrl,
  supabaseServiceRoleKey,
  streamSecretEncryptionKey = process.env.AI_LIVE_OAUTH_ENCRYPTION_KEY,
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
  if (typeof resolveVideoForProduct !== "function") {
    throw new Error("youtube_live_product_video_resolver_required");
  }
  const secretStore = typeof persistStreamSecret === "function" &&
    typeof resolveStreamSecret === "function" && typeof deleteStreamSecret === "function"
    ? { persistStreamSecret, resolveStreamSecret, deleteStreamSecret }
    : createSupabaseYouTubeStreamSecretStore({
      url: supabaseUrl || process.env.SUPABASE_URL,
      serviceRoleKey: supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY,
      encryptionKey: streamSecretEncryptionKey,
      fetchImpl,
    });
  const broadcastControl = createTracerYouTubeLiveControl({
    baseUrl,
    workerToken,
    persistStreamSecret: secretStore.persistStreamSecret,
    deleteStreamSecret: secretStore.deleteStreamSecret,
    fetchImpl,
  });
  return createTracerYouTubeLiveSession({
    broadcastControl,
    deleteStreamSecret: secretStore.deleteStreamSecret,
    ...(sleep ? { sleep } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(activeTimeoutMs !== undefined ? { activeTimeoutMs } : {}),
    ...(onError ? { onError } : {}),
    createMediaRuntime: async () => createAiLiveMediaRuntime({
      secretResolver: secretStore.resolveStreamSecret,
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
