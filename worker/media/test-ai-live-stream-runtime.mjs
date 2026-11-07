import assert from "node:assert/strict";
import { createAiLiveStreamRuntime } from "./ai-live-stream-runtime.mjs";

const calls = [];
let mediaState = "idle";
let productId = null;
const mediaSession = {
  async start(options) {
    calls.push(["start", options.destination]);
    mediaState = "publishing";
  },
  async stop() {
    calls.push(["stop"]);
    mediaState = "stopped";
  },
  async handleComment(event) {
    calls.push(["comment", event.id]);
    return { status: "queued_audio", eventId: event.id };
  },
  setCurrentProduct(id) {
    productId = id;
    calls.push(["product", id]);
    return { currentProductId: id };
  },
  snapshot() { return { state: mediaState, currentProductId: productId }; },
};
const runtime = createAiLiveStreamRuntime({
  mediaSession,
  maxRetries: 2,
  baseDelayMs: 100,
  sleep: async () => {},
});
assert.equal(runtime.snapshot().state, "idle");
const started = await runtime.start({ destination: "youtube_live" });
assert.equal(started.state, "connected");
runtime.setCurrentProduct("product-1");
assert.deepEqual(await runtime.handleComment({ id: "yt:1" }), {
  status: "queued_audio",
  eventId: "yt:1",
});
const reconnected = await runtime.notifyDisconnected("rtmp_disconnected");
assert.equal(reconnected.state, "connected");
assert.equal(reconnected.retries, 1);
assert.deepEqual(calls, [
  ["start", "youtube_live"],
  ["product", "product-1"],
  ["comment", "yt:1"],
  ["stop"],
  ["start", "youtube_live"],
]);
const stopped = await runtime.stop();
assert.equal(stopped.state, "stopped");
assert.equal(stopped.media.state, "stopped");
assert.equal(calls.at(-1)[0], "stop");
console.log("AI Live stream runtime lifecycle and reconnect integration: all assertions passed");
