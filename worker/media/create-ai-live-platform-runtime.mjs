import { createAiLiveDualPlatformCommentBridge } from "../platforms/dual-platform-comment-bridge.mjs";

/**
 * Owns the complete per-session lifecycle:
 * media publisher first, both comment sources second; reverse order on stop.
 * Platform transports and credentials are injected by the deployment host.
 */
export function createAiLivePlatformRuntime({
  mediaRuntime,
  youtubeAdapter,
  tiktokAdapter,
  onError = () => {},
} = {}) {
  if (!mediaRuntime || typeof mediaRuntime.start !== "function" ||
      typeof mediaRuntime.stop !== "function" ||
      typeof mediaRuntime.setCurrentProduct !== "function" ||
      typeof mediaRuntime.handleComment !== "function") {
    throw new Error("valid_media_runtime_required");
  }
  const comments = createAiLiveDualPlatformCommentBridge({
    youtubeAdapter, tiktokAdapter, mediaRuntime, onError,
  });
  let state = "idle";
  let mediaStarted = false;
  let commentsStarted = false;

  return {
    snapshot() {
      return { state, media: mediaRuntime.snapshot?.() ?? null, comments: comments.snapshot() };
    },
    async start({ mediaOptions, youtubeLiveChatId } = {}) {
      if (state === "starting" || state === "running" || state === "stopping") {
        throw new Error("ai_live_platform_runtime_already_active");
      }
      state = "starting";
      try {
        await mediaRuntime.start(mediaOptions);
        mediaStarted = true;
        await comments.start({ youtubeLiveChatId });
        commentsStarted = true;
        state = "running";
        return this.snapshot();
      } catch (error) {
        if (commentsStarted || comments.snapshot().state === "failed") {
          await comments.stop().catch((stopError) =>
            onError({ source: "comment_rollback", error: stopError }));
        }
        if (mediaStarted) {
          await mediaRuntime.stop().catch((stopError) =>
            onError({ source: "media_rollback", error: stopError }));
        }
        commentsStarted = false;
        mediaStarted = false;
        state = "failed";
        onError({ source: "runtime_start", error });
        throw error;
      }
    },
    setCurrentProduct(productId) {
      return mediaRuntime.setCurrentProduct(productId);
    },
    notifyDisconnected(reason) {
      if (typeof mediaRuntime.notifyDisconnected !== "function") {
        throw new Error("media_runtime_reconnect_not_supported");
      }
      return mediaRuntime.notifyDisconnected(reason);
    },
    async stop() {
      if (state === "stopped" || state === "idle") {
        state = "stopped";
        return this.snapshot();
      }
      state = "stopping";
      const results = [];
      if (commentsStarted || comments.snapshot().state === "running" ||
          comments.snapshot().state === "failed") {
        results.push(await comments.stop().then(
          (value) => ({ status: "fulfilled", value }),
          (error) => ({ status: "rejected", error }),
        ));
      }
      if (mediaStarted) {
        results.push(await mediaRuntime.stop().then(
          (value) => ({ status: "fulfilled", value }),
          (error) => ({ status: "rejected", error }),
        ));
      }
      commentsStarted = false;
      mediaStarted = false;
      const failures = results.filter((result) => result.status === "rejected");
      state = failures.length ? "failed" : "stopped";
      for (const failure of failures) onError({ source: "runtime_stop", error: failure.error });
      return this.snapshot();
    },
  };
}
