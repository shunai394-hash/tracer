/**
 * Loads the encrypted-at-rest YouTube refresh token through TRACER's internal
 * worker-only endpoint. The bearer token is a separate worker secret and is
 * never sent to a browser or included in logs.
 */
export function createTracerYouTubeCredentialsProvider({
  baseUrl = process.env.TRACER_BASE_URL,
  workerToken = process.env.AI_LIVE_WORKER_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim() ||
      typeof workerToken !== "string" || workerToken.length < 24 ||
      typeof fetchImpl !== "function") {
    throw new Error("tracer_youtube_credentials_provider_not_configured");
  }
  const endpoint = new URL("/api/admin/ai-live/youtube/credentials", baseUrl);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost") {
    throw new Error("tracer_youtube_credentials_requires_https");
  }

  return async function credentialsProvider({ signal } = {}) {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${workerToken}`, accept: "application/json" },
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    if (!response?.ok) throw new Error("tracer_youtube_credentials_http_" + (response?.status ?? 0));
    let payload;
    try { payload = await response.json(); }
    catch { throw new Error("tracer_youtube_credentials_invalid_json"); }
    if (!payload || payload.ok !== true ||
        typeof payload.clientId !== "string" || payload.clientId.length < 5 ||
        typeof payload.refreshToken !== "string" || payload.refreshToken.length < 10 ||
        (payload.clientSecret != null && typeof payload.clientSecret !== "string")) {
      throw new Error("tracer_youtube_credentials_invalid_response");
    }
    return {
      clientId: payload.clientId,
      ...(payload.clientSecret ? { clientSecret: payload.clientSecret } : {}),
      refreshToken: payload.refreshToken,
    };
  };
}
