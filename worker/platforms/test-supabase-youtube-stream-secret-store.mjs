import assert from "node:assert/strict";
import { createSupabaseYouTubeStreamSecretStore } from "./supabase-youtube-stream-secret-store.mjs";

const key = Buffer.alloc(32, 7).toString("base64");
const db = new Map();
const calls = [];
const fetchImpl = async (url, options) => {
  const parsed = new URL(url);
  calls.push({ url: parsed.toString(), method: options.method, body: options.body });
  if (options.method === "POST") {
    const row = JSON.parse(options.body);
    db.set(row.id, row);
    return new Response(JSON.stringify([{ id: row.id }]), { status: 201 });
  }
  if (options.method === "GET") {
    const id = parsed.searchParams.get("id").replace("eq.", "");
    const row = db.get(id);
    return new Response(JSON.stringify(row ? [{ id: row.id, ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag }] : []), { status: 200 });
  }
  if (options.method === "DELETE") {
    const id = parsed.searchParams.get("id").replace("eq.", "");
    db.delete(id);
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 405 });
};
const store = createSupabaseYouTubeStreamSecretStore({
  url: "https://example.supabase.co",
  serviceRoleKey: "service-role-secret-long-enough",
  encryptionKey: key,
  fetchImpl,
  idFactory: () => "123e4567-e89b-12d3-a456-426614174000",
});
const ref = await store.persistStreamSecret({
  platform: "youtube",
  streamId: "stream_123",
  ingestionAddress: "rtmps://a.rtmp.youtube.com/live2/",
  streamName: "secret-stream-key",
});
assert.equal(ref, "123e4567-e89b-12d3-a456-426614174000");
assert.equal(JSON.stringify([...db.values()]).includes("secret-stream-key"), false);
assert.deepEqual(await store.resolveStreamSecret({ destination: "youtube_live", secretRef: ref }), {
  outputUrl: "rtmps://a.rtmp.youtube.com/live2/secret-stream-key",
});
await store.deleteStreamSecret(ref);
assert.equal(db.has(ref), false);
await assert.rejects(() => store.resolveStreamSecret({ destination: "tiktok_live", secretRef: ref }), /reference_invalid/);
assert.throws(() => createSupabaseYouTubeStreamSecretStore({
  url: "https://example.supabase.co", serviceRoleKey: "service-role-secret-long-enough", encryptionKey: "bad",
}), /encryption_key_invalid/);
console.log("Supabase encrypted YouTube stream secret store: all assertions passed");
