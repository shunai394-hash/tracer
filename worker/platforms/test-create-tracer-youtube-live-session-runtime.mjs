import assert from "node:assert/strict";
import { createTracerYouTubeLiveSessionRuntime } from "./create-tracer-youtube-live-session-runtime.mjs";

assert.throws(
  () => createTracerYouTubeLiveSessionRuntime({}),
  /ai_live_stream_secret_store_configuration_required/,
);
const runtime = createTracerYouTubeLiveSessionRuntime({
  baseUrl: "https://tracer.example",
  workerToken: "worker-token-long-enough-for-tests",
  persistStreamSecret: async () => "123e4567-e89b-12d3-a456-426614174000",
  resolveStreamSecret: async () => ({ outputUrl: "rtmps://a.rtmp.youtube.com/live2/key" }),
  deleteStreamSecret: async () => {},
  resolveVideoForProduct: async () => "products/test.mp4",
  fetchImpl: async () => new Response("{}", { status: 200 }),
});
assert.equal(runtime.snapshot().state, "idle");
console.log("TRACER YouTube production session composition guards: all assertions passed");
