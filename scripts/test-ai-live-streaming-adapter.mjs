import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/ai-live/streaming-adapter.ts", import.meta.url), "utf8");
const playbook = readFileSync(new URL("../docs/ai-live-streaming-adapter.md", import.meta.url), "utf8");

for (const state of ["idle", "starting", "live", "reconnecting", "stopping", "stopped", "failed"]) {
  assert.match(source, new RegExp('"'+state+'"'));
}
for (const reason of [
  "operator_requested",
  "stale_product_facts",
  "inventory_unverified",
  "speech_provider_failed",
  "stream_destination_rejected",
  "worker_shutdown",
  "unknown",
]) assert.match(source, new RegExp('"'+reason+'"'));

assert.match(source, /destinationSecretRef/);
assert.match(source, /maxRuntimeSeconds/);
assert.match(source, /factsVerifiedAt/);
assert.match(source, /start\(job: AiLiveStreamJob\)/);
assert.match(source, /stop\(streamId: string/);
assert.match(source, /getHealth\(streamId: string\)/);
assert.doesNotMatch(source, /streamKey\s*:/i);
assert.doesNotMatch(source, /rtmp:\/\//i);
assert.match(playbook, /Vercel.*長時間/u);
assert.match(playbook, /24時間/u);
assert.match(playbook, /配信先/u);
assert.match(playbook, /stream key|ストリームキー/i);
console.log("AI-live streaming adapter contract: all assertions passed");
