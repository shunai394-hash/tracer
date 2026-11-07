import assert from "node:assert/strict";
import { createYouTubeLiveChatListTransport } from "./youtube-live-chat-list-transport.mjs";

const requests = [];
let tokenCalls = 0;
let responseIndex = 0;
const payloads = [
  {
    items: [{ id: "message-1", snippet: { displayMessage: "hello" } }],
    nextPageToken: "resume-token-1",
    pollingIntervalMillis: 1,
  },
  {
    items: [{ id: "message-2", snippet: { displayMessage: "next" } }],
    nextPageToken: "resume-token-2",
    pollingIntervalMillis: 1,
  },
];
const transport = createYouTubeLiveChatListTransport({
  accessTokenProvider: async () => {
    tokenCalls += 1;
    return "oauth-access-token-for-youtube-test";
  },
  fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    const payload = payloads[responseIndex++];
    return { ok: true, status: 200, async json() { return payload; } };
  },
});

const controller = new AbortController();
const iterator = transport({ liveChatId: "live-chat-123", signal: controller.signal });
const first = await iterator.next();
assert.equal(first.value.items[0].id, "message-1");
assert.equal(first.value.nextPageToken, "resume-token-1");
const second = await iterator.next();
assert.equal(second.value.items[0].id, "message-2");
assert.equal(second.value.nextPageToken, "resume-token-2");
assert.equal(tokenCalls, 2);
assert.equal(requests.length, 2);
assert.equal(requests[0].url.searchParams.get("part"), "id,snippet,authorDetails");
assert.equal(requests[0].url.searchParams.get("liveChatId"), "live-chat-123");
assert.equal(requests[0].url.searchParams.get("maxResults"), "2000");
assert.equal(requests[0].url.searchParams.has("pageToken"), false);
assert.equal(requests[1].url.searchParams.get("pageToken"), "resume-token-1");
assert.equal(requests[0].options.headers.authorization, "Bearer oauth-access-token-for-youtube-test");

controller.abort();
await assert.rejects(() => iterator.next(), { name: "AbortError" });
await assert.rejects(
  () => createYouTubeLiveChatListTransport({ accessTokenProvider: async () => "short" })({
    liveChatId: "live-chat-123", signal: new AbortController().signal,
  }).next(),
  /youtube_oauth_access_token_unavailable/,
);
assert.throws(
  () => createYouTubeLiveChatListTransport({ accessTokenProvider: async () => "x".repeat(20), maxResults: 199 }),
  /max_results_out_of_range/,
);
console.log("YouTube official live chat REST transport: all assertions passed");
