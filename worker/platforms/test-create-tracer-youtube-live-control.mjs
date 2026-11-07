import assert from "node:assert/strict";
import { createTracerYouTubeLiveControl } from "./create-tracer-youtube-live-control.mjs";

assert.throws(
  () => createTracerYouTubeLiveControl({
    baseUrl: "https://tracer-pied-alpha.vercel.app",
    workerToken: "worker-token-012345678901234567890",
  }),
  /access_token_secret_store_and_fetch_required/,
);

let secretSaved = false;
const control = createTracerYouTubeLiveControl({
  baseUrl: "https://tracer-pied-alpha.vercel.app",
  workerToken: "worker-token-012345678901234567890",
  persistStreamSecret: async () => { secretSaved = true; return "secret-ref-1"; },
  fetchImpl: async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "tracer-pied-alpha.vercel.app") {
      return { ok: true, json: async () => ({ ok: true, clientId: "youtube-client-id.apps.googleusercontent.com", refreshToken: "refresh-token-value-123456" }) };
    }
    if (parsed.hostname === "oauth2.googleapis.com") {
      return { ok: true, json: async () => ({ access_token: "fresh-access-token-12345678901234567890", expires_in: 3600 }) };
    }
    if (parsed.hostname === "www.googleapis.com") {
      return { ok: true, json: async () => ({ id: "stream-1", cdn: { ingestionInfo: { ingestionAddress: "rtmps://youtube.example/live", streamName: "hidden-key" } } }) };
    }
    throw new Error("unexpected_host");
  },
});
const result = await control.createBroadcast({ title: "Control factory test" });
assert.equal(secretSaved, true);
assert.equal(result.streamSecretRef, "secret-ref-1");
assert.equal(result.broadcastId, undefined);
console.log("TRACER YouTube live control factory contract: all assertions passed");
