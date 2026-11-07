import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.ok(Date.parse(rotated.segmentChangedAt) > Date.parse(started.segmentChangedAt));

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

  const persistenceCalls = [];
  const fakeStore = {
    async listActive() { return []; },
    async insertNew(record) { persistenceCalls.push(["insert", record.streamId]); return { stream_id: record.streamId }; },
    async claimLease(streamId, options) { persistenceCalls.push(["claim", streamId, options.owner]); return { stream_id: streamId }; },
    async heartbeat(streamId, options) { persistenceCalls.push(["heartbeat", streamId, options.segmentIndex]); return { stream_id: streamId }; },
    async markStopped(streamId, options) { persistenceCalls.push(["stop", streamId, options.reason]); return { stream_id: streamId }; },
  };
  const persistedServer = createAiLiveWorkerServer({ token, mode: "fake", store: fakeStore, workerId: "worker_test_01" });
  await new Promise((resolve) => persistedServer.listen(0, "127.0.0.1", resolve));
  const persistedBase = "http://127.0.0.1:" + persistedServer.address().port;
  const persistedJob = { ...job, streamId: "test_stream_0005" };
  try {
    const startedResponse = await fetch(persistedBase + "/v1/streams", { method: "POST", headers, body: JSON.stringify(persistedJob) });
    assert.equal(startedResponse.status, 202);
    assert.deepEqual(persistenceCalls.slice(0, 2), [
      ["insert", "test_stream_0005"],
      ["claim", "test_stream_0005", "worker_test_01"],
    ]);
    const stopResponse = await fetch(persistedBase + "/v1/streams/test_stream_0005/stop", { method: "POST", headers });
    assert.equal(stopResponse.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(persistenceCalls.some((call) => call[0] === "stop" && call[1] === "test_stream_0005"));
  } finally {
    await new Promise((resolve) => persistedServer.close(resolve));
  }

  const recoveryStore = {
    async insertNew() { throw new Error("not_used_in_recovery_test"); },
    async listActive() {
      return [{
        stream_id: "test_stream_0006",
        status: "live",
        adapter_mode: "fake",
        job_payload: { ...job, streamId: "test_stream_0006" },
        job_fingerprint: createHash("sha256").update(JSON.stringify({ ...job, streamId: "test_stream_0006" })).digest("hex"),
        active_segment_index: 1,
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      }];
    },
    async claimLease(streamId, options) {
      persistenceCalls.push(["reclaim", streamId, options.owner]);
      return { stream_id: streamId };
    },
    async heartbeat(streamId) { return { stream_id: streamId }; },
    async markStopped(streamId, options) { persistenceCalls.push(["recovery_stop", streamId, options.reason]); return { stream_id: streamId }; },
  };
  const recoveryServer = createAiLiveWorkerServer({ token, mode: "fake", store: recoveryStore, workerId: "worker_recovery_01" });
  const recovery = await recoveryServer.restoreActiveStreams();
  assert.deepEqual(recovery, { restored: 1, skipped: 0 });
  await new Promise((resolve) => recoveryServer.listen(0, "127.0.0.1", resolve));
  try {
    const restoredResponse = await fetch("http://127.0.0.1:" + recoveryServer.address().port + "/v1/streams/test_stream_0006", { headers });
    assert.equal(restoredResponse.status, 200);
    const restoredState = await restoredResponse.json();
    assert.equal(restoredState.state, "live");
    assert.equal(restoredState.segmentIndex, 1);
    assert.equal(restoredState.currentSegmentId, "segment-2");
  } finally {
    await new Promise((resolve) => recoveryServer.close(resolve));
  }

  const mediaLifecycle = [];
  const mediaServer = createAiLiveWorkerServer({
    token,
    mode: "fake",
    segmentIntervalMs: 10,
    mediaRuntimeFactory: async ({ job: runtimeJob, workerId: runtimeWorkerId }) => {
      mediaLifecycle.push(["factory", runtimeJob.streamId, runtimeWorkerId]);
      return {
        async start(options) { mediaLifecycle.push(["start", options.profile]); },
        async setCurrentProduct(productId) { mediaLifecycle.push(["product", productId]); },
        async stop() { mediaLifecycle.push(["stop"]); },
      };
    },
    mediaRuntimeOptions: async () => ({ profile: "test-only-injected-runtime" }),
    workerId: "worker_media_test_01",
  });
  await new Promise((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  try {
    const mediaJob = { ...job, streamId: "test_stream_0007" };
    const mediaStart = await fetch("http://127.0.0.1:" + mediaServer.address().port + "/v1/streams", {
      method: "POST", headers, body: JSON.stringify(mediaJob),
    });
    assert.equal(mediaStart.status, 202);
    assert.ok(mediaLifecycle.some((entry) => entry[0] === "start" && entry[1] === "test-only-injected-runtime"));
    assert.ok(mediaLifecycle.some((entry) => entry[0] === "product" && entry[1] === "product-1"));
    const mediaStop = await fetch("http://127.0.0.1:" + mediaServer.address().port + "/v1/streams/test_stream_0007/stop", {
      method: "POST", headers,
    });
    assert.equal(mediaStop.status, 200);
    assert.ok(mediaLifecycle.some((entry) => entry[0] === "stop"));
  } finally {
    await mediaServer.shutdown();
    await new Promise((resolve) => mediaServer.close(resolve));
  }

  assert.throws(() => createAiLiveWorkerServer({ token, mode: "ffmpeg" }), /fake adapter is implemented/);
  console.log("AI Live worker control API and simulated product rotation: all assertions passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
