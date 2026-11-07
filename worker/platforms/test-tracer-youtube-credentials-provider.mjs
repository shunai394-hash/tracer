import assert from "node:assert/strict";
import { createTracerYouTubeCredentialsProvider } from "./tracer-youtube-credentials-provider.mjs";

let request;
const provider = createTracerYouTubeCredentialsProvider({
  baseUrl: "https://tracer-pied-alpha.vercel.app",
  workerToken: "w".repeat(32),
  fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        clientId: "client-id-123",
        clientSecret: "client-secret",
        refreshToken: "refresh-token-123456",
      }),
    };
  },
});
const credentials = await provider();
assert.equal(request.url, "https://tracer-pied-alpha.vercel.app/api/admin/ai-live/youtube/credentials");
assert.equal(request.options.headers.authorization, `Bearer ${"w".repeat(32)}`);
assert.equal(request.options.cache, "no-store");
assert.deepEqual(credentials, {
  clientId: "client-id-123",
  clientSecret: "client-secret",
  refreshToken: "refresh-token-123456",
});

assert.throws(
  () => createTracerYouTubeCredentialsProvider({ baseUrl: "http://example.com", workerToken: "w".repeat(32) }),
  /requires_https/,
);
assert.throws(
  () => createTracerYouTubeCredentialsProvider({ baseUrl: "https://example.com", workerToken: "short" }),
  /not_configured/,
);

console.log("TRACER YouTube credentials provider tests passed");
