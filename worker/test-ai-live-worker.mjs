import assert from "node:assert/strict";
import { createAiLiveWorkerServer } from "./ai-live-worker.mjs";

const token = "test-token-that-is-long-enough-for-worker-auth";
const server = createAiLiveWorkerServer({ token, mode: "fake", segmentIntervalMs: 10 });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const fresh = () => new Date().toISOString();
const job = {
  streamId: "test_stream_0001",
  destination: "youtube_live",
  destinationSecretRef: "live/youtube/primary",
  maxRuntimeSeconds: 120,
  segments: [
    { id: "segment-1", productId: "product-1", scriptText: "Test segment one", factsVersion: "v1", factsVerifiedAt: fresh() },
    { id: "segment-2", productId: "product-2", scriptText: "Test segment two", factsVersion: "v1", factsVerifiedAt: fresh() },
  ],
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
  assert.equal(started.currentSegmentId, "segment-1");
  assert.equal(started.segmentCount, 2);

  await new Promise((resolve) => setTimeout(resolve, 35));
  response = await fetch(base + "/v1/streams/" + job.streamId, { headers });
  const rotated = await response.json();
  assert.ok(["segment-1", "segment-2"].includes(rotated.currentSegmentId));
  assert.ok(rotated.segmentIndex === 0 || rotated.segmentIndex === 1);

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

  const badDuration = structuredClone(job);
  badDuration.streamId = "test_stream_0004";
  badDuration.segmentDurationSeconds = 5;
  response = await fetch(base + "/v1/streams", { method: "POST", headers, body: JSON.stringify(badDuration) });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "segment_duration_out_of_bounds");

  response = await fetch(base + "/v1/streams/" + job.streamId + "/stop", { method: "POST", headers });
  assert.equal(response.status, 200);
  const stopped = await response.json();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stopReason, "operator_requested");

  const stoppedIndex = stopped.segmentIndex;
  await new Promise((resolve) => setTimeout(resolve, 25));
  response = await fetch(base + "/v1/streams/" + job.streamId, { headers });
  const afterStop = await response.json();
  assert.equal(afterStop.state, "stopped");
  assert.equal(afterStop.segmentIndex, stoppedIndex);

  assert.throws(() => createAiLiveWorkerServer({ token, mode: "ffmpeg" }), /fake adapter is implemented/);
  console.log("AI Live worker control API and simulated product rotation: all assertions passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
