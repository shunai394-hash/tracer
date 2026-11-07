import assert from "node:assert/strict";
import { createAiLiveDualPlatformCommentBridge } from "./dual-platform-comment-bridge.mjs";

const received = [];
const errors = [];
function adapter(name) {
  let state = "idle";
  let forward = null;
  return {
    snapshot: () => ({ state }),
    setOnComment(handler) { forward = handler; },
    async start() {
      state = "connected";
      return { state };
    },
    async emit(event) { await forward(event); },
    async stop() { state = "stopped"; return { state }; },
  };
}
const youtube = adapter("youtube");
const tiktok = adapter("tiktok");
const bridge = createAiLiveDualPlatformCommentBridge({
  youtubeAdapter: youtube,
  tiktokAdapter: tiktok,
  mediaRuntime: { async handleComment(event) { received.push(event); } },
  onError: (error) => errors.push(error),
});
assert.equal((await bridge.start({ youtubeLiveChatId: "live-chat-1" })).state, "running");
await youtube.emit({ id: "youtube_live:1", platform: "youtube_live", text: "質問1" });
await tiktok.emit({ id: "tiktok_live:2", platform: "tiktok_live", text: "質問2" });
await tiktok.emit({ id: "invalid", platform: "other", text: "ignored" });
assert.deepEqual(received.map((event) => event.platform), ["youtube_live", "tiktok_live"]);
assert.equal((await bridge.stop()).state, "stopped");
assert.deepEqual(errors, []);
await assert.rejects(() => bridge.start({ youtubeLiveChatId: "" }), /youtube_live_chat_id_required/);

const failing = createAiLiveDualPlatformCommentBridge({
  youtubeAdapter: adapter("youtube"),
  tiktokAdapter: {
    snapshot: () => ({ state: "idle" }),
    setOnComment() {},
    async start() { throw new Error("connector_unavailable"); },
    async stop() { return { state: "stopped" }; },
  },
  mediaRuntime: { async handleComment() {} },
});
await assert.rejects(() => failing.start({ youtubeLiveChatId: "live-chat-1" }), /dual_platform_comment_adapter_start_failed/);
assert.equal(failing.snapshot().state, "failed");
console.log("AI Live dual-platform comment bridge: all assertions passed");
