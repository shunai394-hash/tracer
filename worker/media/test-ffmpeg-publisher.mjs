import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { buildFfmpegArgs, createFfmpegPublisher } from "./ffmpeg-publisher.mjs";

const args = buildFfmpegArgs({
  videoPath: "/app/media/loop.mp4",
  bgmPath: "/app/media/soft.mp3",
  outputUrl: "rtmps://a.rtmp.youtube.com/live2/secret",
});
assert.ok(args.includes("pipe:0"));
assert.ok(args.includes("libx264"));
assert.ok(args.includes("amix=inputs=2:duration=longest:dropout_transition=2:normalize=0"));
assert.equal(args.at(-1), "rtmps://a.rtmp.youtube.com/live2/secret");

let spawnCalls = [];
let stateEvents = [];
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    this.stderr = new EventEmitter();
  }
  kill(signal) {
    this.killed = true;
    this.signalCode = signal;
    this.exitCode = 1;
    this.emit("exit", 1, signal);
    return true;
  }
}
const child = new FakeChild();
const publisher = createFfmpegPublisher({
  mediaRoot: "/app/media",
  secretResolver: async ({ destination, secretRef }) => {
    assert.equal(destination, "youtube_live");
    assert.equal(secretRef, "live/youtube/primary");
    return { outputUrl: "rtmps://a.rtmp.youtube.com/live2/private-key" };
  },
  spawnImpl: (...call) => { spawnCalls.push(call); return child; },
  onState: (value) => stateEvents.push(value.state),
});
const started = await publisher.start({
  destination: "youtube_live",
  destinationSecretRef: "live/youtube/primary",
  videoFile: "loop.mp4",
  bgmFile: "soft.mp3",
});
assert.equal(started.state, "publishing");
assert.equal(spawnCalls.length, 1);
assert.equal(spawnCalls[0][2].shell, false);
assert.deepEqual(spawnCalls[0][2].stdio, ["pipe", "ignore", "pipe"]);
assert.equal(spawnCalls[0][1].at(-1), "rtmps://a.rtmp.youtube.com/live2/private-key");
assert.deepEqual([...await publisher.writeSpeechAudio(new Uint8Array([1, 2, 3]))], [1, 2, 3]);
assert.equal((await publisher.stop()).state, "stopped");
assert.ok(stateEvents.includes("starting"));
assert.ok(stateEvents.includes("publishing"));
assert.ok(stateEvents.includes("stopping"));
assert.ok(!JSON.stringify(publisher.snapshot()).includes("private-key"));

const rejected = createFfmpegPublisher({
  mediaRoot: "/app/media",
  secretResolver: async () => ({ outputUrl: "rtmps://evil.example/live/key" }),
  spawnImpl: () => { throw new Error("must_not_spawn"); },
});
await assert.rejects(() => rejected.start({
  destination: "youtube_live",
  destinationSecretRef: "live/youtube/primary",
  videoFile: "loop.mp4",
  bgmFile: "soft.mp3",
}), /destination_host_mismatch/);

await assert.rejects(() => publisher.start({
  destination: "youtube_live",
  destinationSecretRef: "live/youtube/primary",
  videoFile: "../outside.mp4",
  bgmFile: "soft.mp3",
}), /media_path_outside_root/);

const tiktok = createFfmpegPublisher({
  mediaRoot: "/app/media",
  secretResolver: async () => ({ outputUrl: "rtmps://push.tiktokcdn.com/live/opaque" }),
  spawnImpl: () => new FakeChild(),
});
assert.equal((await tiktok.start({
  destination: "tiktok_live",
  destinationSecretRef: "live/tiktok/session",
  videoFile: "loop.mp4",
  bgmFile: "soft.mp3",
})).state, "publishing");
await tiktok.stop();

console.log("AI Live FFmpeg publisher contract: all assertions passed");
