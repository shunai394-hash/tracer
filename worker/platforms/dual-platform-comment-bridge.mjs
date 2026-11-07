/**
 * Starts YouTube Live and TikTok LIVE comment adapters together and forwards
 * normalized, privacy-minimized events into the shared media runtime.
 * Authentication and platform transports remain injected at the host boundary.
 */
export function createAiLiveDualPlatformCommentBridge({
  youtubeAdapter,
  tiktokAdapter,
  mediaRuntime,
  onError = () => {},
} = {}) {
  for (const [name, adapter] of [["youtubeAdapter", youtubeAdapter], ["tiktokAdapter", tiktokAdapter]]) {
    if (!adapter || typeof adapter.start !== "function" || typeof adapter.stop !== "function" ||
        typeof adapter.snapshot !== "function") {
      throw new Error(name + "_is_required");
    }
  }
  if (!mediaRuntime || typeof mediaRuntime.handleComment !== "function") {
    throw new Error("media_runtime_handle_comment_required");
  }

  let state = "idle";
  let started = false;

  const forward = async (event) => {
    if (!event || !["youtube_live", "tiktok_live"].includes(event.platform) ||
        typeof event.id !== "string" || typeof event.text !== "string") return;
    try {
      await mediaRuntime.handleComment(event);
    } catch (error) {
      onError({ source: "media_runtime", platform: event.platform, error });
    }
  };

  return {
    snapshot() {
      return {
        state,
        youtube: youtubeAdapter.snapshot(),
        tiktok: tiktokAdapter.snapshot(),
      };
    },
    async start({ youtubeLiveChatId } = {}) {
      if (started) throw new Error("dual_platform_comment_bridge_already_started");
      if (typeof youtubeLiveChatId !== "string" || !youtubeLiveChatId.trim()) {
        throw new Error("youtube_live_chat_id_required");
      }
      state = "starting";
      const starts = await Promise.allSettled([
        youtubeAdapter.start(youtubeLiveChatId, forward),
        tiktokAdapter.start(forward),
      ]);
      const failed = starts.find((result) => result.status === "rejected");
      if (failed) {
        await Promise.allSettled([youtubeAdapter.stop(), tiktokAdapter.stop()]);
        state = "failed";
        onError({ source: "adapter_start", error: failed.reason });
        throw new Error("dual_platform_comment_adapter_start_failed");
      }
      started = true;
      state = "running";
      return this.snapshot();
    },
    async stop() {
      if (!started && state !== "starting") {
        if (state !== "failed") state = "stopped";
        return this.snapshot();
      }
      state = "stopping";
      const results = await Promise.allSettled([youtubeAdapter.stop(), tiktokAdapter.stop()]);
      started = false;
      state = results.some((result) => result.status === "rejected") ? "failed" : "stopped";
      for (const result of results) {
        if (result.status === "rejected") onError({ source: "adapter_stop", error: result.reason });
      }
      return this.snapshot();
    },
  };
}
