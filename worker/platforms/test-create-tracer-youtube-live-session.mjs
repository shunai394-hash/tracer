import assert from "node:assert/strict";
import { createTracerYouTubeLiveSession } from "./create-tracer-youtube-live-session.mjs";

const events = [];
let chatHandler;
const control = {
  async createBroadcast() {
    events.push("broadcast:create");
    return { broadcastId: "broadcast-1", streamId: "stream-1", streamSecretRef: "secret-ref-1" };
  },
  async getStatus() {
    events.push("broadcast:status");
    return { stream: { streamStatus: "active" }, broadcast: { lifeCycleStatus: "ready" } };
  },
  async startBroadcast(args) {
    assert.equal(args.confirmEncoderActive, true);
    events.push("broadcast:live");
    return { liveChatId: "chat-1" };
  },
  async completeBroadcast() { events.push("broadcast:complete"); },
  async cancelBroadcast() { events.push("broadcast:cancel"); },
};
const media = {
  async setCurrentProduct(id) { events.push("media:product:" + id); },
  async start(options) {
    assert.equal(options.destination, "youtube_live");
    assert.equal(options.destinationSecretRef, "secret-ref-1");
    events.push("media:start");
  },
  async handleComment(event) { events.push("comment:" + event.id); },
  async stop() { events.push("media:stop"); },
  snapshot() { return { state: "mock" }; },
};
const session = createTracerYouTubeLiveSession({
  broadcastControl: control,
  createMediaRuntime: async (options) => {
    assert.equal(options.destinationSecretRef, "secret-ref-1");
    return media;
  },
  createChatClient: async ({ onComment }) => {
    chatHandler = onComment;
    return {
      async start(id) { assert.equal(id, "chat-1"); events.push("chat:start"); },
      async stop() { events.push("chat:stop"); },
      snapshot() { return { state: "mock" }; },
    };
  },
  deleteStreamSecret: async (ref) => { assert.equal(ref, "secret-ref-1"); events.push("secret:delete"); },
  sleep: async () => {},
  pollIntervalMs: 250,
  activeTimeoutMs: 500,
});
await session.start({ title: "Test stream", productId: "product-1", mediaOptions: {
  destination: "tiktok_live", destinationSecretRef: "attacker-ref",
  videoFile: "product.mp4", bgmFile: "bgm.mp3",
} });
assert.equal(session.snapshot().state, "running");
await chatHandler({ id: "comment-1" });
await session.stop();
assert.equal(session.snapshot().state, "stopped");
assert.deepEqual(events, [
  "broadcast:create",
  "media:product:product-1",
  "media:start",
  "broadcast:status",
  "broadcast:live",
  "chat:start",
  "comment:comment-1",
  "chat:stop",
  "media:stop",
  "broadcast:complete",
  "secret:delete",
]);

const failedEvents = [];
const failed = createTracerYouTubeLiveSession({
  broadcastControl: {
    ...control,
    async getStatus() { return { stream: { streamStatus: "inactive" }, broadcast: { lifeCycleStatus: "ready" } }; },
    async cancelBroadcast() { failedEvents.push("cancel"); },
  },
  createMediaRuntime: async () => ({
    async setCurrentProduct() {},
    async start() { failedEvents.push("media:start"); },
    async stop() { failedEvents.push("media:stop"); },
  }),
  createChatClient: async () => { throw new Error("must_not_start_chat"); },
  sleep: async () => {},
  pollIntervalMs: 250,
  activeTimeoutMs: 250,
});
await assert.rejects(() => failed.start({ title: "Failure test", productId: "product-1" }), /ingest_activation_timeout/);
assert.equal(failed.snapshot().state, "failed");
assert.deepEqual(failedEvents, ["media:start", "cancel", "media:stop"]);
console.log("TRACER YouTube live session orchestration: all assertions passed");

const retryEvents = [];
let mediaStopAttempts = 0;
const retrySession = createTracerYouTubeLiveSession({
  broadcastControl: {
    ...control,
    async getStatus() {
      return { stream: { streamStatus: "active" }, broadcast: { lifeCycleStatus: "ready" } };
    },
    async startBroadcast() { return { liveChatId: "chat-retry" }; },
    async completeBroadcast() { retryEvents.push("broadcast:complete"); },
  },
  createMediaRuntime: async () => ({
    async setCurrentProduct() {},
    async start() { retryEvents.push("media:start"); },
    async stop() {
      mediaStopAttempts += 1;
      retryEvents.push("media:stop:" + mediaStopAttempts);
      if (mediaStopAttempts === 1) throw new Error("encoder_still_stopping");
    },
  }),
  createChatClient: async () => ({
    async start() { retryEvents.push("chat:start"); },
    async stop() { retryEvents.push("chat:stop"); },
  }),
  deleteStreamSecret: async () => { retryEvents.push("secret:delete"); },
  sleep: async () => {},
  pollIntervalMs: 250,
  activeTimeoutMs: 500,
});
await retrySession.start({ title: "Retry stop", productId: "product-1" });
await retrySession.stop();
assert.equal(retrySession.snapshot().state, "failed");
assert.equal(retryEvents.includes("secret:delete"), false);
await retrySession.stop();
assert.equal(retrySession.snapshot().state, "stopped");
assert.deepEqual(retryEvents, [
  "media:start",
  "chat:start",
  "chat:stop",
  "media:stop:1",
  "broadcast:complete",
  "media:stop:2",
  "secret:delete",
]);
