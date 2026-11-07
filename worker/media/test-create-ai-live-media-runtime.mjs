import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createAiLiveMediaRuntime } from "./create-ai-live-media-runtime.mjs";

const children = [];
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    this.stderr = new EventEmitter();
  }
  kill(signal) {
    this.signalCode = signal;
    this.exitCode = 1;
    this.emit("exit", 1, signal);
    return true;
  }
}
const runtime = createAiLiveMediaRuntime({
  mediaRoot: "/app/media",
  secretResolver: async () => ({ outputUrl: "rtmps://a.rtmp.youtube.com/live2/opaque" }),
  speechBridge: { async synthesize() { return { status: "handoff" }; } },
  resolveVideoForProduct: async (id) => `products/${id}.mp4`,
  spawnImpl: () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  },
  maxRetries: 2,
  baseDelayMs: 100,
  sleep: async () => {},
});
const started = await runtime.start({
  destination: "youtube_live",
  destinationSecretRef: "live/youtube/primary",
  videoFile: "loop.mp4",
  bgmFile: "soft.mp3",
});
assert.equal(started.state, "connected");
assert.equal(children.length, 1);
await runtime.setCurrentProduct("product-42");
assert.equal(children.length, 2, "changing product should switch the FFmpeg video input");
children[1].exitCode = 1;
children[1].emit("exit", 1, null);
for (let i = 0; i < 10 && children.length < 3; i += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}
assert.equal(children.length, 3, "unexpected FFmpeg exit should automatically reconnect");
assert.equal(runtime.snapshot().state, "connected");
await runtime.stop();
assert.equal(runtime.snapshot().state, "stopped");
console.log("AI Live concrete media runtime disconnect/reconnect contract: all assertions passed");
