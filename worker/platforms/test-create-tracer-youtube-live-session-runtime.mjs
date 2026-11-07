import assert from "node:assert/strict";
import { createTracerYouTubeLiveSessionRuntime } from "./create-tracer-youtube-live-session-runtime.mjs";

assert.throws(
  () => createTracerYouTubeLiveSessionRuntime({}),
  /youtube_live_secret_manager_contract_required/,
);
console.log("TRACER YouTube production session composition guard: all assertions passed");
