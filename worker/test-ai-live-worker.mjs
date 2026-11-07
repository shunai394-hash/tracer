import assert from "node:assert/strict";
import { createAiLiveWorkerServer } from "./ai-live-worker.mjs";

const token = "test-token-that-is-long-enough-for-worker-auth";
const server = createAiLiveWorkerServer({ token, mode: "fake" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const job = {
  streamId: "test_stream_0001",
  destination: "youtube_live",
  destinationSecretRef: "live/youtube/primary",
  maxRuntimeSeconds: 120,
  segments: [{
    id: "segment-1",
    productId: "product-1",
    scriptText: "Test segment",
    factsVersion: "v1",
    factsVerifiedAt: new Date().toISOString(),
  }],
};

try {
  let response = await fetch(base + "/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  response = await fetch(base + "/v1/streams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) });
  assert.equal(response.status, 401);

  response = await fetch(base + "/v1/streams", { method: "POST", headers, body: JSON.stringify(job) });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.state, "live");
  assert.equal(started.simulated, true);
  assert.equal(started.adapterMode, "fake");

  response = await fetch(base + "/v1/streams", { method: "POST", headers, body: JSON.stringify(job) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).streamId, job.streamId);

  response = await fetch(base + "/v1/streams", {
    method: "POST", headers,
    body: JSON.stringify({ ...job, streamId: "test_stream_0002", rtmpUrl: "rtmp://invalid/key" }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "credentials_must_not_be_in_job");

  const stale = structuredClone(job);
  stale.streamId = "test_stream_0003";
  stale.segments[0].factsVerifiedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  response = await fetch(base + "/v1/streams", { method: "POST", headers, body: JSON.stringify(stale) });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "stale_product_facts");

  response = await fetch(base + "/v1/streams/" + job.streamId + "/stop", { method: "POST", headers });
  assert.equal(response.status, 200);
  const stopped = await response.json();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stopReason, "operator_requested");

  response = await fetch(base + "/v1/streams/" + job.streamId, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "stopped");

  assert.throws(() => createAiLiveWorkerServer({ token, mode: "ffmpeg" }), /fake adapter is implemented/);
  console.log("AI Live worker control API: all assertions passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
