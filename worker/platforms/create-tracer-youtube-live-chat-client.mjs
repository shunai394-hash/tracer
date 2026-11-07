import { createGoogleOAuthAccessTokenProvider } from "./google-oauth-access-token-provider.mjs";
import { createTracerYouTubeCredentialsProvider } from "./tracer-youtube-credentials-provider.mjs";
import { createYouTubeLiveChatListTransport } from "./youtube-live-chat-list-transport.mjs";
import { createYouTubeLiveChatAdapter } from "./youtube-live-chat-adapter.mjs";

/**
 * Creates a complete authenticated YouTube Live chat client from the
 * encrypted TRACER credential endpoint through OAuth refresh, official
 * liveChatMessages.list transport, and privacy-minimized comment adapter.
 */
export function createTracerYouTubeLiveChatClient({
  baseUrl,
  workerToken,
  fetchImpl = fetch,
  onComment = async () => {},
  onError = () => {},
  maxReconnects,
  baseDelayMs,
  maxDelayMs,
} = {}) {
  const credentialsProvider = createTracerYouTubeCredentialsProvider({
    baseUrl, workerToken, fetchImpl,
  });
  const accessTokenProvider = createGoogleOAuthAccessTokenProvider({
    credentialsProvider, fetchImpl,
  });
  const streamList = createYouTubeLiveChatListTransport({
    accessTokenProvider, fetchImpl,
  });
  const adapter = createYouTubeLiveChatAdapter({
    streamList,
    onComment,
    onError,
    ...(maxReconnects !== undefined ? { maxReconnects } : {}),
    ...(baseDelayMs !== undefined ? { baseDelayMs } : {}),
    ...(maxDelayMs !== undefined ? { maxDelayMs } : {}),
  });
  return {
    start: (liveChatId) => adapter.start(liveChatId),
    stop: () => adapter.stop(),
    snapshot: () => adapter.snapshot(),
    setOnComment: (handler) => adapter.setOnComment(handler),
  };
}
