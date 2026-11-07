import { createReconnectSupervisor } from "./reconnect-supervisor.mjs";

/**
 * Coordinates one media session with bounded reconnects. Platform adapters
 * must call notifyDisconnected() when the RTMP publisher reports a dropped
 * connection. Authentication/eligibility failures should stop the runtime
 * instead of entering this retry path.
 */
export function createAiLiveStreamRuntime({
  mediaSession,
  maxRetries = 8,
  baseDelayMs = 2_000,
  maxDelayMs = 60_000,
  sleep,
  onState = () => {},
} = {}) {
  if (!mediaSession || typeof mediaSession.start !== "function" ||
      typeof mediaSession.stop !== "function" ||
      typeof mediaSession.handleComment !== "function" ||
      typeof mediaSession.setCurrentProduct !== "function") {
    throw new Error("valid_media_session_required");
  }

  let startOptions = null;
  let state = "idle";
  const supervisor = createReconnectSupervisor({
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    ...(sleep ? { sleep } : {}),
    startAttempt: async () => {
      if (!startOptions) throw new Error("stream_not_configured");
      await mediaSession.start(startOptions);
    },
    stopAttempt: async () => {
      await mediaSession.stop();
    },
    onState: (snapshot) => {
      state = snapshot.state;
      onState({ ...snapshot, media: mediaSession.snapshot() });
    },
  });

  return {
    snapshot() {
      return { ...supervisor.snapshot(), media: mediaSession.snapshot() };
    },
    async start(options) {
      if (state === "connected") return this.snapshot();
      startOptions = options;
      return supervisor.start();
    },
    setCurrentProduct(productId) {
      return mediaSession.setCurrentProduct(productId);
    },
    handleComment(event) {
      return mediaSession.handleComment(event);
    },
    notifyDisconnected(reason) {
      return supervisor.notifyDisconnected(reason);
    },
    async stop(options) {
      startOptions = null;
      const result = await supervisor.stop();
      return { ...result, media: mediaSession.snapshot(), stopOptions: options ?? null };
    },
  };
}
