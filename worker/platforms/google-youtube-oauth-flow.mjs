import { randomBytes, timingSafeEqual } from "node:crypto";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const YOUTUBE_LIVE_OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube";

function requiredString(value, name, max = 2048) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error("google_oauth_invalid_" + name);
  }
  return value;
}

/**
 * Build a Google authorization URL for the YouTube channel owner.
 * Persist the returned state server-side with a short TTL and bind it to the
 * initiating admin session before redirecting the user to Google.
 */
export function createGoogleYouTubeAuthorizationRequest({
  clientId,
  redirectUri,
  state = randomBytes(32).toString("base64url"),
  scope = YOUTUBE_LIVE_OAUTH_SCOPE,
} = {}) {
  requiredString(clientId, "client_id", 512);
  requiredString(redirectUri, "redirect_uri", 2048);
  requiredString(state, "state", 256);
  if (scope !== YOUTUBE_LIVE_OAUTH_SCOPE) throw new Error("google_oauth_scope_not_allowed");

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return { authorizationUrl: url.toString(), state };
}

/** Constant-time state comparison for the OAuth callback handler. */
export function verifyGoogleOAuthState(receivedState, expectedState) {
  if (typeof receivedState !== "string" || typeof expectedState !== "string" ||
      !receivedState || !expectedState || receivedState.length > 256 || expectedState.length > 256) {
    return false;
  }
  const received = Buffer.from(receivedState);
  const expected = Buffer.from(expectedState);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Exchange a one-time authorization code. The caller must verify state first,
 * then securely persist refresh_token; never send token data to the browser.
 */
export async function exchangeGoogleYouTubeAuthorizationCode({
  code,
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = fetch,
} = {}) {
  requiredString(code, "authorization_code", 4096);
  requiredString(clientId, "client_id", 512);
  requiredString(clientSecret, "client_secret", 2048);
  requiredString(redirectUri, "redirect_uri", 2048);
  if (typeof fetchImpl !== "function") throw new Error("google_oauth_fetch_required");

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    throw new Error("google_oauth_code_exchange_http_" + status);
  }

  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("google_oauth_code_exchange_invalid_json"); }
  if (!payload || typeof payload.access_token !== "string" ||
      payload.access_token.length < 20 || payload.access_token.length > 8192 ||
      typeof payload.refresh_token !== "string" ||
      payload.refresh_token.length < 10 || payload.refresh_token.length > 8192 ||
      !Number.isFinite(payload.expires_in) || payload.expires_in < 60 || payload.expires_in > 86_400 ||
      typeof payload.token_type !== "string" || payload.token_type.toLowerCase() !== "bearer") {
    throw new Error("google_oauth_code_exchange_invalid_response");
  }
  const grantedScopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  if (!grantedScopes.includes(YOUTUBE_LIVE_OAUTH_SCOPE)) {
    throw new Error("google_oauth_required_scope_not_granted");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresInSeconds: payload.expires_in,
    tokenType: "Bearer",
    scope: YOUTUBE_LIVE_OAUTH_SCOPE,
  };
}
