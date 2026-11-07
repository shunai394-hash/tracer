const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * Creates an in-memory Google OAuth access-token provider for a YouTube channel.
 * credentialsProvider must load { clientId, clientSecret?, refreshToken } from
 * the deployment's secret store. No credentials or tokens are persisted here.
 */
export function createGoogleOAuthAccessTokenProvider({
  credentialsProvider,
  fetchImpl = fetch,
  refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
  now = Date.now,
} = {}) {
  if (typeof credentialsProvider !== "function" || typeof fetchImpl !== "function") {
    throw new Error("google_oauth_credentials_provider_and_fetch_required");
  }
  if (!Number.isInteger(refreshSkewMs) || refreshSkewMs < 0 || refreshSkewMs > 300_000) {
    throw new Error("google_oauth_refresh_skew_out_of_range");
  }

  let cached = null;
  let inFlight = null;

  return async function getAccessToken({ signal } = {}) {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const currentTime = now();
    if (cached && cached.expiresAt - refreshSkewMs > currentTime) return cached.accessToken;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const credentials = await credentialsProvider();
      if (!credentials || typeof credentials.clientId !== "string" ||
          credentials.clientId.length < 5 || credentials.clientId.length > 512 ||
          typeof credentials.refreshToken !== "string" ||
          credentials.refreshToken.length < 10 || credentials.refreshToken.length > 8192 ||
          (credentials.clientSecret != null &&
            (typeof credentials.clientSecret !== "string" || credentials.clientSecret.length > 2048))) {
        throw new Error("google_oauth_refresh_credentials_unavailable");
      }

      const body = new URLSearchParams({
        client_id: credentials.clientId,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      });
      if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);

      const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        ...(signal ? { signal } : {}),
      });
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 0;
        throw new Error("google_oauth_refresh_http_" + status);
      }

      let payload;
      try { payload = await response.json(); }
      catch { throw new Error("google_oauth_refresh_invalid_json"); }
      if (!payload || typeof payload.access_token !== "string" ||
          payload.access_token.length < 20 || payload.access_token.length > 8192 ||
          !Number.isFinite(payload.expires_in) || payload.expires_in < 60 || payload.expires_in > 86_400) {
        throw new Error("google_oauth_refresh_invalid_response");
      }
      cached = { accessToken: payload.access_token, expiresAt: now() + payload.expires_in * 1000 };
      return cached.accessToken;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
