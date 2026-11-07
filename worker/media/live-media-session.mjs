import { createCommentDeduplicator } from "../platforms/normalize-comment.mjs";
import { createCommentSpeechPipeline } from "../platforms/tracer-speech-bridge.mjs";

/**
 * Joins the existing verified-product speech route to the FFmpeg stdin audio
 * pipe. The caller must start the publisher only after platform eligibility and
 * secret resolution have been confirmed.
 */
export function createAiLiveMediaSession({ publisher, speechBridge, resolveVideoForProduct = null, deduplicator = createCommentDeduplicator() } = {}) {
  if (!publisher || typeof publisher.start !== "function" ||
      typeof publisher.writeSpeechAudio !== "function" ||
      typeof publisher.stop !== "function") {
    throw new Error("FFmpeg publisher is required");
  }
  if (!speechBridge || typeof speechBridge.synthesize !== "function") {
    throw new Error("TRACER speech bridge is required");
  }

  if (resolveVideoForProduct !== null && typeof resolveVideoForProduct !== "function") {
    throw new Error("resolveVideoForProduct_must_be_a_function");
  }

  let currentProductId = null;
  let requestedProductId = null;
  let state = "idle";
  let activeStartOptions = null;
  let switchQueue = Promise.resolve();
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
        const videoFile = currentProductId && resolveVideoForProduct
          ? await resolveVideoForProduct(currentProductId)
          : options.videoFile;
        if (typeof videoFile !== "string" || !videoFile.trim()) throw new Error("product_video_asset_missing");
        activeStartOptions = { ...options, videoFile };
        await publisher.start(activeStartOptions);
        state = "publishing";
        return this.snapshot();
      } catch {
        state = "failed";
        throw new Error("media_session_start_failed");
      }
    },
    async setCurrentProduct(productId) {
      if (typeof productId !== "string" || !productId.trim() || productId.length > 128) {
        throw new Error("invalid_product_id");
      }
      if (currentProductId === productId) return this.snapshot();
      if (state === "publishing" && resolveVideoForProduct) {
        if (typeof publisher.switchVideo !== "function") throw new Error("publisher_video_switch_unsupported");
        requestedProductId = productId;
        const switchTask = async () => {
          if (requestedProductId !== productId) return;
          const videoFile = await resolveVideoForProduct(productId);
          if (requestedProductId !== productId || state !== "publishing") return;
          if (typeof videoFile !== "string" || !videoFile.trim()) throw new Error("product_video_asset_missing");
          await publisher.switchVideo(videoFile);
          currentProductId = productId;
          activeStartOptions = { ...activeStartOptions, videoFile };
        };
        switchQueue = switchQueue.then(switchTask, switchTask);
        await switchQueue;
      } else {
        currentProductId = productId;
        requestedProductId = productId;
      }
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
        await switchQueue;
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
