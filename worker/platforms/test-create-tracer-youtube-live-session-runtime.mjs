import assert from "node:assert/strict";
import { createTracerYouTubeLiveSessionRuntime } from "./create-tracer-youtube-live-session-runtime.mjs";

assert.throws(
  () => createTracerYouTubeLiveSessionRuntime({}),
  /ai_live_stream_secret_store_configuration_required/,
);
const secretManager = {
  async persistStreamSecret() { return "123e4567-e89b-12d3-a456-426614174000"; },
  async resolveStreamSecret() { return { outputUrl: "rtmps://a.rtmp.youtube.com/live2/key" }; },
  async deleteStreamSecret() {},
};
assert.throws(
  () => createTracerYouTubeLiveSessionRuntime(secretManager),
  /ai_live_stream_secret_store_configuration_required/,
);
console.log("TRACER YouTube production session composition guards: all assertions passed");
