import assert from "node:assert/strict";
import { createYouTubeLiveChatAdapter } from "./youtube-live-chat-adapter.mjs";

const calls = [];
const received = [];
let secondResolve;
const secondStarted = new Promise((resolve) => { secondResolve = resolve; });
const adapter = createYouTubeLiveChatAdapter({
  maxReconnects: 2,
  baseDelayMs: 1,
  maxDelayMs: 2,
  streamList: async ({ liveChatId, pageToken, signal }) => {
    calls.push({ liveChatId, pageToken });
    if (calls.length === 1) {
      return (async function* () {
        yield {
          nextPageToken: "resume-token-1",
          items: [{
            id: "yt-comment-1",
            snippet: {
              type: "textMessageEvent",
              displayMessage: "質問です",
              publishedAt: "2026-11-07T01:00:00Z",
            },
            authorDetails: { displayName: "discarded" },
          }],
        };
      })();
    }
    secondResolve();
    return (async function* () {
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", resolve, { once: true });
      });
    })();
  },
  onComment: async (event) => received.push(event),
});
assert.equal((await adapter.start("live-chat-123")).state, "connecting");
await secondStarted;
assert.deepEqual(calls, [
  { liveChatId: "live-chat-123", pageToken: null },
  { liveChatId: "live-chat-123", pageToken: "resume-token-1" },
]);
assert.equal(received.length, 1);
assert.equal(received[0].text, "質問です");
assert.equal("authorDetails" in received[0], false);
assert.equal((await adapter.stop()).state, "stopped");
assert.equal(adapter.snapshot().hasResumeToken, true);
console.log("YouTube Live chat adapter resume and normalization: all assertions passed");
