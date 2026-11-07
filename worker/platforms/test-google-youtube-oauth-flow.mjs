import assert from "node:assert/strict";
import {
  createGoogleYouTubeAuthorizationRequest,
  exchangeGoogleYouTubeAuthorizationCode,
  verifyGoogleOAuthState,
  YOUTUBE_LIVE_OAUTH_SCOPE,
} from "./google-youtube-oauth-flow.mjs";

const request = createGoogleYouTubeAuthorizationRequest({
  clientId: "youtube-client-id.apps.googleusercontent.com",
  redirectUri: "https://tracer.example/api/admin/ai-live/youtube/callback",
  state: "csrf-state-value",
});
const authUrl = new URL(request.authorizationUrl);
assert.equal(authUrl.origin + authUrl.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
assert.equal(authUrl.searchParams.get("response_type"), "code");
assert.equal(authUrl.searchParams.get("access_type"), "offline");
assert.equal(authUrl.searchParams.get("prompt"), "consent");
assert.equal(authUrl.searchParams.get("scope"), YOUTUBE_LIVE_OAUTH_SCOPE);
assert.equal(authUrl.searchParams.get("state"), "csrf-state-value");
assert.equal(verifyGoogleOAuthState("csrf-state-value", "csrf-state-value"), true);
assert.equal(verifyGoogleOAuthState("attacker-state", "csrf-state-value"), false);
assert.throws(() => createGoogleYouTubeAuthorizationRequest({
  clientId: "youtube-client-id", redirectUri: "https://example.com/callback", scope: "openid",
}), /scope_not_allowed/);

let requestBody;
const exchanged = await exchangeGoogleYouTubeAuthorizationCode({
  code: "one-time-authorization-code",
  clientId: "youtube-client-id.apps.googleusercontent.com",
  clientSecret: "deployment-client-secret",
  redirectUri: "https://tracer.example/api/admin/ai-live/youtube/callback",
  fetchImpl: async (url, options) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    requestBody = options.body;
    return {
      ok: true,
      async json() {
        return {
          access_token: "google-access-token-long-enough",
          refresh_token: "google-refresh-token-long-enough",
          expires_in: 3600,
          token_type: "Bearer",
          scope: YOUTUBE_LIVE_OAUTH_SCOPE,
        };
      },
    };
  },
});
assert.equal(requestBody.get("grant_type"), "authorization_code");
assert.equal(requestBody.get("code"), "one-time-authorization-code");
assert.equal(exchanged.refreshToken, "google-refresh-token-long-enough");
assert.equal(exchanged.scope, YOUTUBE_LIVE_OAUTH_SCOPE);
await assert.rejects(() => exchangeGoogleYouTubeAuthorizationCode({
  code: "code", clientId: "youtube-client-id", clientSecret: "secret",
  redirectUri: "https://example.com/callback",
  fetchImpl: async () => ({ ok: true, async json() { return {
    access_token: "google-access-token-long-enough",
    refresh_token: "google-refresh-token-long-enough",
    expires_in: 3600, token_type: "Bearer", scope: "openid",
  }; } }),
}), /required_scope_not_granted/);
console.log("Google YouTube OAuth authorization-code flow: all assertions passed");
