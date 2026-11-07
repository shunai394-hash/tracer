import { createGoogleOAuthAccessTokenProvider } from "./google-oauth-access-token-provider.mjs";
import { createTracerYouTubeCredentialsProvider } from "./tracer-youtube-credentials-provider.mjs";
import { createYouTubeLiveBroadcastManager } from "./youtube-live-broadcast-manager.mjs";

/**
 * Builds the authenticated YouTube broadcast controller using credentials
 * encrypted and stored by TRACER. RTMP stream keys are delegated to the
 * deployment's secret manager and represented by opaque references only.
 */
export function createTracerYouTubeLiveControl({
  baseUrl,
  workerToken,
  persistStreamSecret,
  deleteStreamSecret,
  fetchImpl = fetch,
  now,
} = {}) {
  const credentialsProvider = createTracerYouTubeCredentialsProvider({
    baseUrl, workerToken, fetchImpl,
  });
  const accessTokenProvider = createGoogleOAuthAccessTokenProvider({
    credentialsProvider, fetchImpl,
  });
  const manager = createYouTubeLiveBroadcastManager({
    accessTokenProvider,
    persistStreamSecret,
    ...(deleteStreamSecret ? { deleteStreamSecret } : {}),
    fetchImpl,
    ...(now ? { now } : {}),
  });
  return manager;
}
