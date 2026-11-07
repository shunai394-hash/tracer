import assert from "node:assert/strict";
import { createYouTubeLiveBroadcastManager } from "./youtube-live-broadcast-manager.mjs";

const calls = [];
const secrets = [];
let streamState = "active";
let broadcastState = "ready";
const manager = createYouTubeLiveBroadcastManager({
  accessTokenProvider: async () => "google-access-token-value-123456",
  persistStreamSecret: async (secret) => { secrets.push(secret); return "secret-ref-youtube-001"; },
  now: () => Date.parse("2026-11-08T00:00:00.000Z"),
  fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: parsed, method: options.method, body });
    let payload;
    if (parsed.pathname.endsWith("/liveStreams") && options.method === "POST") {
      payload = { id: "stream_123", cdn: { ingestionInfo: { ingestionAddress: "rtmps://a.rtmp.youtube.com/live2", streamName: "private-stream-key" } } };
    } else if (parsed.pathname.endsWith("/liveBroadcasts") && options.method === "POST") {
      payload = { id: "broadcast_123", status: { lifeCycleStatus: "created" } };
    } else if (parsed.pathname.endsWith("/liveBroadcasts/bind")) {
      payload = { id: "broadcast_123", status: { lifeCycleStatus: "ready" }, contentDetails: { boundStreamId: "stream_123" } };
    } else if (parsed.pathname.endsWith("/liveStreams") && options.method === "GET") {
      payload = { items: [{ id: "stream_123", status: { streamStatus: streamState } }] };
    } else if (parsed.pathname.endsWith("/liveBroadcasts") && options.method === "GET") {
      payload = { items: [{ id: "broadcast_123", snippet: { title: "Test live", liveChatId: "chat_123" }, status: { lifeCycleStatus: broadcastState }, contentDetails: { boundStreamId: "stream_123" } }] };
    } else if (parsed.pathname.endsWith("/liveBroadcasts/transition")) {
      broadcastState = parsed.searchParams.get("broadcastStatus");
      payload = { id: "broadcast_123", snippet: { liveChatId: "chat_123" }, status: { lifeCycleStatus: broadcastState } };
    } else throw new Error("unexpected_test_request:" + parsed.pathname);
    return { ok: true, status: 200, json: async () => payload };
  },
});

const created = await manager.createBroadcast({ title: "TRACER AI LIVE", description: "test", privacyStatus: "unlisted" });
assert.equal(created.broadcastId, "broadcast_123");
assert.equal(created.streamId, "stream_123");
assert.equal(created.streamSecretRef, "secret-ref-youtube-001");
assert.equal(created.lifeCycleStatus, "ready");
assert.equal(created.liveChatId, null);
assert.equal(JSON.stringify(created).includes("private-stream-key"), false);
assert.equal(secrets.length, 1);
assert.equal(secrets[0].streamName, "private-stream-key");
assert.equal(secrets[0].platform, "youtube");
assert.equal(calls[0].method, "POST");
assert.equal(calls[0].url.searchParams.get("part"), "snippet,cdn,contentDetails");
assert.equal(calls[1].url.pathname.endsWith("/liveBroadcasts"), true);
assert.equal(calls[2].url.pathname.endsWith("/liveBroadcasts/bind"), true);
assert.equal(calls[1].body.contentDetails.enableMonitorStream, false);

await assert.rejects(() => manager.startBroadcast({ broadcastId: "broadcast_123", streamId: "stream_123" }), /encoder_confirmation_required/);
streamState = "inactive";
await assert.rejects(() => manager.startBroadcast({ broadcastId: "broadcast_123", streamId: "stream_123", confirmEncoderActive: true }), /ingest_stream_not_active/);
streamState = "active";
const started = await manager.startBroadcast({ broadcastId: "broadcast_123", streamId: "stream_123", confirmEncoderActive: true });
assert.equal(started.lifeCycleStatus, "live");
assert.equal(started.liveChatId, "chat_123");

const status = await manager.getStatus({ broadcastId: "broadcast_123", streamId: "stream_123" });
assert.equal(status.broadcast.liveChatId, "chat_123");
assert.equal(status.stream.streamStatus, "active");
assert.equal(JSON.stringify(status).includes("private-stream-key"), false);

const completed = await manager.completeBroadcast({ broadcastId: "broadcast_123" });
assert.equal(completed.lifeCycleStatus, "complete");
await assert.rejects(() => manager.createBroadcast({ title: "Bad", privacyStatus: "made-up" }), /invalid_privacy_status/);
console.log("YouTube Live broadcast manager lifecycle contract: all assertions passed");
