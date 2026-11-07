import assert from "node:assert/strict";
import { createSupabaseAiLiveStore } from "./supabase-ai-live-store.mjs";

const calls = [];
const fetchImpl = async (url, init = {}) => {
  calls.push({ url, init });
  if (init.method === "POST") return new Response(JSON.stringify([{ stream_id: "stream_0001", status: "live" }]), { status: 201 });
  if (init.method === "PATCH") return new Response(JSON.stringify([{ stream_id: "stream_0001", status: "live" }]), { status: 200 });
  return new Response(JSON.stringify([{ stream_id: "stream_0001", status: "live" }]), { status: 200 });
};
const store = createSupabaseAiLiveStore({
  url: "https://example.supabase.co",
  serviceRoleKey: "service-role-key-for-tests-only-123456",
  fetchImpl,
});
const record = {
  streamId: "stream_0001",
  destination: "youtube_live",
  status: "live",
  adapterMode: "fake",
  jobFingerprint: "a".repeat(64),
  jobPayload: {
    streamId: "stream_0001",
    destination: "youtube_live",
    destinationSecretRef: "live/youtube/primary",
    segments: [{ id: "seg1", productId: "prod1", scriptText: "demo" }],
  },
  activeSegmentIndex: 0,
  activeProductId: "prod1",
  reconnectCount: 0,
  heartbeatAt: new Date().toISOString(),
  leaseOwner: "worker_instance_01",
  leaseExpiresAt: new Date(Date.now() + 45_000).toISOString(),
  startedAt: new Date().toISOString(),
};
assert.deepEqual(await store.upsert(record), { stream_id: "stream_0001", status: "live" });
assert.equal(calls[0].init.method, "POST");
assert.match(calls[0].url, /on_conflict=stream_id/);
assert.equal(calls[0].init.headers.apikey, "service-role-key-for-tests-only-123456");
assert.equal(JSON.parse(calls[0].init.body).job_payload.destinationSecretRef, "live/youtube/primary");
assert.ok(!calls[0].init.body.includes("rtmp://"));

await store.get("stream_0001");
assert.match(calls[1].url, /stream_id=eq.stream_0001/);
await store.listActive();
assert.match(calls[2].url, /status=in.\(starting,live,reconnecting\)/);

const claimed = await store.claimLease("stream_0001", { owner: "worker_instance_02", leaseSeconds: 45 });
assert.equal(claimed.stream_id, "stream_0001");
assert.match(calls[3].url, /\/rpc\/claim_ai_live_worker_stream$/);
assert.equal(JSON.parse(calls[3].init.body).p_owner, "worker_instance_02");
assert.equal(calls[3].init.method, "POST");

await store.heartbeat("stream_0001", {
  owner: "worker_instance_01",
  segmentIndex: 1,
  productId: "prod2",
  reconnectCount: 2,
});
assert.equal(calls[4].init.method, "PATCH");
assert.equal(JSON.parse(calls[4].init.body).active_product_id, "prod2");

const inserted = await store.insertNew(record);
assert.equal(inserted.stream_id, "stream_0001");
assert.match(calls[5].url, /on_conflict=stream_id/);
assert.match(calls[5].init.headers.prefer, /resolution=ignore-duplicates/);
assert.match(calls[4].url, /lease_owner=eq.worker_instance_01/);
assert.match(calls[4].url, /lease_expires_at=gt\./);

await store.markStopped("stream_0001", { owner: "worker_instance_01" });
assert.equal(JSON.parse(calls[6].init.body).status, "stopped");
assert.match(calls[6].url, /lease_owner=eq.worker_instance_01/);

assert.throws(() => createSupabaseAiLiveStore({ url: "http://example.supabase.co", serviceRoleKey: "service-role-key-for-tests-only-123456" }), /https/);
await assert.rejects(() => store.heartbeat("stream_0001", { owner: "bad", segmentIndex: 0, reconnectCount: 0 }), /invalid_lease_owner/);
await assert.rejects(() => store.upsert({ ...record, jobPayload: { ...record.jobPayload, streamKey: "must-not-persist" } }), /credentials_must_not_be_persisted/);
console.log("AI Live Supabase state store contract: all assertions passed");
