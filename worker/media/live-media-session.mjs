import { createCommentDeduplicator } from "../platforms/normalize-comment.mjs";
import { createCommentSpeechPipeline } from "../platforms/tracer-speech-bridge.mjs";

/**
 * Joins the existing verified-product speech route to the FFmpeg stdin audio
 * pipe. The caller must start the publisher only after platform eligibility and
 * secret resolution have been confirmed.
 */
export function createAiLiveMediaSession({ publisher, speechBridge, deduplicator = createCommentDeduplicator() } = {}) {
  if (!publisher || typeof publisher.start !== "function" ||
      typeof publisher.writeSpeechAudio !== "function" ||
      typeof publisher.stop !== "function") {
    throw new Error("FFmpeg publisher is required");
  }
  if (!speechBridge || typeof speechBridge.synthesize !== "function") {
    throw new Error("TRACER speech bridge is required");
  }

  let currentProductId = null;
  let state = "idle";
  const speechPipeline = createCommentSpeechPipeline({
    bridge: speechBridge,
    deduplicator,
    onAudio: async ({ audio }) => {
      if (state !== "publishing") throw new Error("media_session_not_publishing");
      await publisher.writeSpeechAudio(audio);
    },
  });

  return {
    snapshot() {
      return {
        state,
        currentProductId,
        publisher: typeof publisher.snapshot === "function" ? publisher.snapshot() : null,
      };
    },
    async start(options) {
      if (state === "publishing") return this.snapshot();
      state = "starting";
      try {
        await publisher.start(options);
        state = "publishing";
        return this.snapshot();
      } catch {
        state = "failed";
        throw new Error("media_session_start_failed");
      }
    },
    setCurrentProduct(productId) {
      if (typeof productId !== "string" || !productId.trim() || productId.length > 128) {
        throw new Error("invalid_product_id");
      }
      currentProductId = productId;
      return this.snapshot();
    },
    async handleComment(event) {
      if (state !== "publishing") return { status: "rejected", reason: "media_session_not_publishing" };
      if (!currentProductId) return { status: "rejected", reason: "product_context_missing" };
      return speechPipeline.handle({ event, productId: currentProductId });
    },
    async stop(options) {
      if (state === "stopped" || state === "idle") {
        state = "stopped";
        return this.snapshot();
      }
      state = "stopping";
      try {
        await publisher.stop(options);
        state = "stopped";
        return this.snapshot();
      } catch {
        state = "failed";
        throw new Error("media_session_stop_failed");
      }
    },
  };
}
