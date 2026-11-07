import assert from "node:assert/strict";
import { createTikTokLiveConnectorAdapter } from "./tiktok-live-connector-adapter.mjs";

let connectCount = 0;
const received = [];
let connectedAgain;
const secondConnect = new Promise((resolve) => { connectedAgain = resolve; });
const adapter = createTikTokLiveConnectorAdapter({
  connector: {
    async connect({ signal }) {
      connectCount += 1;
      if (connectCount === 1) {
        return (async function* () {
          yield {
            source: "approved_tiktok_live_connector",
            commentId: "tt-comment-1",
            text: "色は何色ですか?",
            createdAt: "2026-11-07T01:01:00Z",
            user: { nickname: "discarded" },
          };
        })();
      }
      connectedAgain();
      return (async function* () {
        await new Promise((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", resolve, { once: true });
        });
      })();
    },
  },
  onComment: async (event) => received.push(event),
  baseDelayMs: 1,
  maxDelayMs: 2,
});
assert.equal((await adapter.start()).state, "connecting");
await secondConnect;
assert.equal(connectCount, 2);
assert.equal(received.length, 1);
assert.deepEqual(received[0], {
  id: "tiktok_live:tt-comment-1",
  platform: "tiktok_live",
  text: "色は何色ですか?",
  createdAt: "2026-11-07T01:01:00.000Z",
  kind: "text_comment",
});
assert.equal((await adapter.stop()).state, "stopped");
console.log("Approved TikTok LIVE connector adapter contract: all assertions passed");
