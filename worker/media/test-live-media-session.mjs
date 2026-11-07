import assert from "node:assert/strict";
import { createAiLiveMediaSession } from "./live-media-session.mjs";

const calls = [];
let publisherState = "idle";
const publisher = {
  async start(options) { calls.push(["start", options.destination]); publisherState = "publishing"; },
  async writeSpeechAudio(audio) { calls.push(["audio", [...audio]]); },
  async stop() { calls.push(["stop"]); publisherState = "stopped"; },
  snapshot() { return { state: publisherState }; },
};
const bridge = {
  async synthesize({ comment, productId }) {
    calls.push(["synthesize", comment, productId]);
    return { status: "spoken_audio", mimeType: "audio/mpeg", audio: new Uint8Array([8, 9]) };
  },
};
const session = createAiLiveMediaSession({ publisher, speechBridge: bridge });
assert.equal(session.snapshot().state, "idle");
assert.deepEqual(
  await session.handleComment({ id: "yt:1", text: "質問です" }),
  { status: "rejected", reason: "media_session_not_publishing" },
);
await session.start({ destination: "youtube_live" });
assert.equal(session.snapshot().state, "publishing");
assert.throws(() => session.setCurrentProduct(""), /invalid_product_id/);
session.setCurrentProduct("product-42");
const event = {
  id: "youtube_live:comment-1",
  platform: "youtube_live",
  text: "価格を教えて",
  createdAt: new Date().toISOString(),
  kind: "text_comment",
};
assert.deepEqual(
  await session.handleComment(event),
  { status: "queued_audio", eventId: event.id },
);
assert.deepEqual(calls, [
  ["start", "youtube_live"],
  ["synthesize", "価格を教えて", "product-42"],
  ["audio", [8, 9]],
]);
assert.deepEqual(
  await session.handleComment(event),
  { status: "duplicate" },
);
await session.stop();
assert.equal(session.snapshot().state, "stopped");
assert.deepEqual(calls.at(-1), ["stop"]);
console.log("AI Live media session comment-to-FFmpeg audio wiring: all assertions passed");
