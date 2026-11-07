import assert from "node:assert/strict";
import { createTracerYouTubeLiveSessionRuntime } from "./create-tracer-youtube-live-session-runtime.mjs";

assert.throws(
  () => createTracerYouTubeLiveSessionRuntime({}),
  /ai_live_stream_secret_store_configuration_required/,
);
console.log("TRACER YouTube production session composition guard: all assertions passed");
