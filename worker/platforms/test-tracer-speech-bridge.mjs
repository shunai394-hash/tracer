import assert from "node:assert/strict";
import {
  createCommentSpeechPipeline,
  createTracerspeechBridge,
} from "./tracer-speech-bridge.mjs";
import { createCommentDeduplicator } from "./normalize-comment.mjs";

const token = "a-test-token-that-is-long-enough-to-use";
const calls = [];
const bridge = createTracerspeechBridge({
  baseUrl: "https://tracer.example",
  token,
  fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": "3" },
    });
  },
});
const audioEvents = [];
const pipeline = createCommentSpeechPipeline({
  bridge,
  deduplicator: createCommentDeduplicator({ maxEntries: 10 }),
  onAudio: async (item) => audioEvents.push(item),
});
const event = {
  id: "youtube_live:message-1",
  platform: "youtube_live",
  text: "この商品の価格はいくらですか？",
  createdAt: "2026-11-07T01:00:00.000Z",
  kind: "text_comment",
};

const result = await pipeline.handle({ event, productId: "listing-123" });
assert.deepEqual(result, { status: "queued_audio", eventId: event.id });
assert.equal(calls.length, 1);
assert.equal(calls[0].url, "https://tracer.example/api/admin/ai-live/speak-reply");
assert.equal(calls[0].init.method, "POST");
assert.equal(calls[0].init.headers.authorization, "Bearer " + token);
assert.deepEqual(JSON.parse(calls[0].init.body), {
  comment: event.text,
  productId: "listing-123",
});
assert.equal(audioEvents.length, 1);
assert.deepEqual([...audioEvents[0].audio], [1, 2, 3]);
assert.equal(audioEvents[0].eventId, event.id);
assert.equal("token" in result, false);

assert.deepEqual(
  await pipeline.handle({ event, productId: "listing-123" }),
  { status: "duplicate" },
);
assert.equal(calls.length, 1);

const handoffBridge = createTracerspeechBridge({
  baseUrl: "https://tracer.example",
  token,
  fetchImpl: async () => new Response(JSON.stringify({
    ok: true,
    spoken: false,
    reason: "comment_requires_human",
  }), { status: 200, headers: { "content-type": "application/json" } }),
});
const handoff = await handoffBridge.synthesize({ comment: "返品したい", productId: "listing-123" });
assert.deepEqual(handoff, { status: "handoff", reason: "comment_requires_human" });

let oversizedBodyCancelled = false;
const oversizedBridge = createTracerspeechBridge({
  baseUrl: "https://tracer.example",
  token,
  maxAudioBytes: 3,
  fetchImpl: async () => new Response(new ReadableStream({
    cancel() { oversizedBodyCancelled = true; },
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
  }), { status: 200, headers: { "content-type": "audio/mpeg" } }),
});
const oversized = await oversizedBridge.synthesize({ comment: "価格は？", productId: "listing-123" });
assert.deepEqual(oversized, { status: "failed", reason: "audio_too_large" });
assert.equal(oversizedBodyCancelled, true);

const invalid = await bridge.synthesize({ comment: " ", productId: "listing-123" });
assert.deepEqual(invalid, { status: "rejected", reason: "invalid_comment" });

assert.throws(() => createTracerspeechBridge({
  baseUrl: "http://tracer.example",
  token,
}), /HTTPS/);
console.log("AI Live comment-to-speech bridge contract: all assertions passed");
