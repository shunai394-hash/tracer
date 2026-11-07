import assert from "node:assert/strict";
import { createGoogleOAuthAccessTokenProvider } from "./google-oauth-access-token-provider.mjs";

let currentTime = 1_000_000;
let refreshCalls = 0;
const requests = [];
const provider = createGoogleOAuthAccessTokenProvider({
  credentialsProvider: async () => ({
    clientId: "youtube-client-id.apps.googleusercontent.com",
    clientSecret: "deployment-secret",
    refreshToken: "secure-refresh-token-value",
  }),
  now: () => currentTime,
  fetchImpl: async (url, options) => {
    requests.push({ url, options });
    refreshCalls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { access_token: "fresh-google-access-token-value", expires_in: 3600, token_type: "Bearer" };
      },
    };
  },
});
const [a, b] = await Promise.all([provider(), provider()]);
assert.equal(a, "fresh-google-access-token-value");
assert.equal(b, a);
assert.equal(refreshCalls, 1, "concurrent refresh calls must be coalesced");
assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
assert.equal(requests[0].options.method, "POST");
assert.equal(requests[0].options.body.get("grant_type"), "refresh_token");
assert.equal(requests[0].options.body.get("client_id"), "youtube-client-id.apps.googleusercontent.com");
assert.equal(requests[0].options.body.get("client_secret"), "deployment-secret");
assert.equal(requests[0].options.body.get("refresh_token"), "secure-refresh-token-value");
assert.equal(await provider(), a, "valid access token should be cached in memory");
currentTime += 3_550_000;
assert.equal(await provider(), a);
assert.equal(refreshCalls, 2, "token should refresh inside configured expiry skew");

const failed = createGoogleOAuthAccessTokenProvider({
  credentialsProvider: async () => ({ clientId: "youtube-client-id", refreshToken: "secure-refresh-token-value" }),
  fetchImpl: async () => ({ ok: false, status: 400 }),
});
await assert.rejects(() => failed(), /google_oauth_refresh_http_400/);
const malformed = createGoogleOAuthAccessTokenProvider({
  credentialsProvider: async () => ({ clientId: "youtube-client-id", refreshToken: "secure-refresh-token-value" }),
  fetchImpl: async () => ({ ok: true, async json() { return { access_token: "short", expires_in: 3600 }; } }),
});
await assert.rejects(() => malformed(), /google_oauth_refresh_invalid_response/);
console.log("Google OAuth refresh-token provider: all assertions passed");
