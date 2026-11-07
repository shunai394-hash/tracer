import assert from "node:assert/strict";
import { createTracerYouTubeLiveChatClient } from "./create-tracer-youtube-live-chat-client.mjs";

const requests = [];
let chatRequestCount = 0;
const client = createTracerYouTubeLiveChatClient({
  baseUrl: "https://tracer-pied-alpha.vercel.app",
  workerToken: "worker-token-012345678901234567890",
  fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, options });
    if (parsed.hostname === "tracer-pied-alpha.vercel.app") {
      return { ok: true, status: 200, json: async () => ({
        ok: true, clientId: "youtube-client-id.apps.googleusercontent.com",
        clientSecret: "secret-value", refreshToken: "refresh-token-value-123456",
      }) };
    }
    if (parsed.hostname === "oauth2.googleapis.com") {
      return { ok: true, status: 200, json: async () => ({
        access_token: "fresh-access-token-12345678901234567890",
        expires_in: 3600, token_type: "Bearer",
      }) };
    }
    if (parsed.hostname === "www.googleapis.com") {
      chatRequestCount += 1;
      return { ok: true, status: 200, json: async () => ({
        items: [{ id: "comment-1", snippet: { type: "textMessageEvent", textMessageDetails: { messageText: "こんにちは" }, publishedAt: "2026-11-08T00:00:00Z" } }],
        nextPageToken: "resume-token-1",
        pollingIntervalMillis: 1,
      }) };
    }
    throw new Error("unexpected_host");
  },
  maxReconnects: 0,
});
const events = [];
client.setOnComment(async (event) => events.push(event));
await client.start("live-chat-id-123");
await new Promise((resolve) => setTimeout(resolve, 30));
await client.stop();
assert.equal(chatRequestCount >= 1, true);
assert.equal(events[0]?.platform, "youtube_live");
assert.equal(events[0]?.text, "こんにちは");
assert.equal(requests.some((item) => item.url.hostname === "tracer-pied-alpha.vercel.app"), true);
assert.equal(requests.some((item) => item.url.hostname === "oauth2.googleapis.com"), true);
assert.equal(requests.some((item) => item.url.hostname === "www.googleapis.com"), true);
assert.equal(client.snapshot().state, "stopped");
console.log("TRACER authenticated YouTube Live chat client integration: all assertions passed");
