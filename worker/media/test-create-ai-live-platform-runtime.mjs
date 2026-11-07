import assert from "node:assert/strict";
import { createAiLivePlatformRuntime } from "./create-ai-live-platform-runtime.mjs";

const events = [];
const received = [];
const media = {
  async start(options) { events.push(["media_start", options]); },
  async stop() { events.push(["media_stop"]); },
  async setCurrentProduct(id) { events.push(["product", id]); },
  async handleComment(event) { received.push(event); },
  async notifyDisconnected(reason) { events.push(["disconnect", reason]); },
  snapshot() { return { state: "connected" }; },
};
function adapter(name, fail = false) {
  let handler = async () => {};
  let state = "idle";
  return {
    snapshot: () => ({ state }),
    setOnComment(callback) { handler = callback; },
    async start() {
      events.push([name + "_start"]);
      if (fail) throw new Error(name + "_unavailable");
      state = "connected";
    },
    async emit(event) { await handler(event); },
    async stop() { events.push([name + "_stop"]); state = "stopped"; },
  };
}
const youtube = adapter("youtube");
const tiktok = adapter("tiktok");
const runtime = createAiLivePlatformRuntime({
  mediaRuntime: media, youtubeAdapter: youtube, tiktokAdapter: tiktok,
});
assert.equal((await runtime.start({
  mediaOptions: { destination: "test" }, youtubeLiveChatId: "live-chat-1",
})).state, "running");
await youtube.emit({ id: "youtube_live:1", platform: "youtube_live", text: "質問" });
await tiktok.emit({ id: "tiktok_live:2", platform: "tiktok_live", text: "色は?" });
assert.deepEqual(received.map((event) => event.platform), ["youtube_live", "tiktok_live"]);
await runtime.setCurrentProduct("product-2");
await runtime.notifyDisconnected("network_drop");
assert.equal((await runtime.stop()).state, "stopped");
assert.deepEqual(events.map((event) => event[0]), [
  "media_start", "youtube_start", "tiktok_start",
  "product", "disconnect", "youtube_stop", "tiktok_stop", "media_stop",
]);

const failedEvents = [];
const failedRuntime = createAiLivePlatformRuntime({
  mediaRuntime: {
    async start() { failedEvents.push("media_start"); },
    async stop() { failedEvents.push("media_stop"); },
    async setCurrentProduct() {},
    async handleComment() {},
    snapshot() { return {}; },
  },
  youtubeAdapter: adapter("youtube-fail", true),
  tiktokAdapter: adapter("tiktok-ok"),
});
await assert.rejects(
  () => failedRuntime.start({ mediaOptions: {}, youtubeLiveChatId: "live-chat-1" }),
  /dual_platform_comment_adapter_start_failed/,
);
assert.equal(failedRuntime.snapshot().state, "failed");
assert.deepEqual(failedEvents, ["media_start", "media_stop"]);
console.log("AI Live platform runtime lifecycle: all assertions passed");
