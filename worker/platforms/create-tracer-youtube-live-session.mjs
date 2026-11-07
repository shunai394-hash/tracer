/**
 * Orchestrates one authenticated YouTube Live session:
 * create broadcast -> start FFmpeg -> verify ingest -> transition live ->
 * attach official chat. The destination secret reference is the only stream
 * credential passed between components; raw RTMP keys remain in the secret
 * manager and are resolved inside the media runtime.
 */
export function createTracerYouTubeLiveSession({
  broadcastControl,
  createMediaRuntime,
  createChatClient,
  deleteStreamSecret = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 2_000,
  activeTimeoutMs = 90_000,
  onError = () => {},
} = {}) {
  if (!broadcastControl || typeof broadcastControl.createBroadcast !== "function" ||
      typeof broadcastControl.getStatus !== "function" ||
      typeof broadcastControl.startBroadcast !== "function" ||
      typeof broadcastControl.completeBroadcast !== "function" ||
      typeof createMediaRuntime !== "function" || typeof createChatClient !== "function") {
    throw new Error("youtube_live_session_dependencies_required");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 10_000 ||
      !Number.isInteger(activeTimeoutMs) || activeTimeoutMs < pollIntervalMs || activeTimeoutMs > 180_000 ||
      typeof sleep !== "function") {
    throw new Error("invalid_youtube_live_session_timing");
  }

  let state = "idle";
  let broadcast = null;
  let mediaRuntime = null;
  let chatClient = null;
  let live = false;

  const snapshot = () => ({
    state,
    broadcastId: broadcast?.broadcastId ?? null,
    streamId: broadcast?.streamId ?? null,
    hasStreamSecretRef: Boolean(broadcast?.streamSecretRef),
    media: mediaRuntime?.snapshot?.() ?? null,
    chat: chatClient?.snapshot?.() ?? null,
  });

  async function waitForIngest(signal) {
    const deadline = Date.now() + activeTimeoutMs;
    let lastStatus = null;
    while (Date.now() <= deadline) {
      const current = await broadcastControl.getStatus({
        broadcastId: broadcast.broadcastId,
        streamId: broadcast.streamId,
        signal,
      });
      lastStatus = current.stream?.streamStatus ?? null;
      if (lastStatus === "active") return current;
      if (["error", "inactive"].includes(lastStatus) && Date.now() + pollIntervalMs > deadline) break;
      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error("youtube_live_ingest_activation_timeout:" + (lastStatus ?? "unknown"));
  }

  async function cleanupFailedStart() {
    if (chatClient) {
      try {
        await chatClient.stop();
        chatClient = null;
      } catch (error) {
        onError({ source: "chat_rollback", error });
      }
    }
    let mediaStopped = !mediaRuntime;
    if (mediaRuntime) {
      try {
        await mediaRuntime.stop();
        mediaRuntime = null;
        mediaStopped = true;
      } catch (error) {
        onError({ source: "media_rollback", error });
      }
    }
    // Never revoke an ingest key while the encoder may still be publishing.
    if (!mediaStopped) return;
    if (live && broadcast) {
      try {
        await broadcastControl.completeBroadcast({ broadcastId: broadcast.broadcastId });
        live = false;
      } catch (error) {
        onError({ source: "broadcast_rollback", error });
      }
    } else if (broadcast && typeof broadcastControl.cancelBroadcast === "function") {
      try {
        await broadcastControl.cancelBroadcast({
          broadcastId: broadcast.broadcastId,
          streamId: broadcast.streamId,
          streamSecretRef: broadcast.streamSecretRef,
        });
      } catch (error) {
        onError({ source: "broadcast_cancel", error });
        await deleteStreamSecret(broadcast.streamSecretRef)
          .catch((secretError) => onError({ source: "secret_rollback", error: secretError }));
      }
    } else if (broadcast?.streamSecretRef) {
      await deleteStreamSecret(broadcast.streamSecretRef)
        .catch((error) => onError({ source: "secret_rollback", error }));
    }
  }

  return {
    snapshot,
    async start({
      title,
      description = "",
      privacyStatus = "unlisted",
      productId,
      mediaOptions,
      signal,
    } = {}) {
      if (state === "starting" || state === "running" || state === "stopping") {
        throw new Error("youtube_live_session_already_active");
      }
      state = "starting";
      try {
        if (typeof productId !== "string" || !productId.trim()) {
          throw new Error("youtube_live_initial_product_required");
        }
        broadcast = await broadcastControl.createBroadcast({
          title, description, privacyStatus, signal,
        });
        if (!broadcast?.broadcastId || !broadcast?.streamId ||
            typeof broadcast.streamSecretRef !== "string" || !broadcast.streamSecretRef) {
          throw new Error("youtube_live_broadcast_creation_incomplete");
        }
        mediaRuntime = await createMediaRuntime({
          destination: "youtube_live",
          destinationSecretRef: broadcast.streamSecretRef,
        });
        if (!mediaRuntime || typeof mediaRuntime.start !== "function" ||
            typeof mediaRuntime.stop !== "function" ||
            typeof mediaRuntime.setCurrentProduct !== "function") {
          throw new Error("youtube_live_media_runtime_invalid");
        }
        await mediaRuntime.setCurrentProduct(productId);
        await mediaRuntime.start({
          ...(mediaOptions && typeof mediaOptions === "object" ? mediaOptions : {}),
          destination: "youtube_live",
          destinationSecretRef: broadcast.streamSecretRef,
        });
        await waitForIngest(signal);
        const started = await broadcastControl.startBroadcast({
          broadcastId: broadcast.broadcastId,
          streamId: broadcast.streamId,
          confirmEncoderActive: true,
          signal,
        });
        live = true;
        const liveChatId = started?.liveChatId || broadcast.liveChatId;
        if (!liveChatId) throw new Error("youtube_live_chat_id_missing_after_start");
        chatClient = await createChatClient({
          liveChatId,
          onComment: (event) => mediaRuntime.handleComment(event),
        });
        if (!chatClient || typeof chatClient.start !== "function" ||
            typeof chatClient.stop !== "function") {
          throw new Error("youtube_live_chat_client_invalid");
        }
        await chatClient.start(liveChatId);
        state = "running";
        return snapshot();
      } catch (error) {
        await cleanupFailedStart();
        state = "failed";
        onError({ source: "youtube_live_session_start", error });
        throw error;
      }
    },
    async stop({ signal } = {}) {
      if (state === "idle" || state === "stopped") {
        state = "stopped";
        return snapshot();
      }
      if (state === "starting" || state === "stopping") {
        throw new Error("youtube_live_session_transition_in_progress");
      }
      state = "stopping";
      const failures = [];
      if (chatClient) {
        try {
          await chatClient.stop();
          chatClient = null;
        } catch (error) { failures.push({ source: "chat_stop", error }); }
      }
      let mediaStopped = !mediaRuntime;
      if (mediaRuntime) {
        try {
          await mediaRuntime.stop();
          mediaRuntime = null;
          mediaStopped = true;
        } catch (error) { failures.push({ source: "media_stop", error }); }
      }
      if (live && broadcast) {
        try {
          await broadcastControl.completeBroadcast({ broadcastId: broadcast.broadcastId, signal });
          live = false;
        } catch (error) { failures.push({ source: "broadcast_complete", error }); }
      }
      if (mediaStopped && !live && broadcast?.streamSecretRef) {
        try { await deleteStreamSecret(broadcast.streamSecretRef); }
        catch (error) { failures.push({ source: "secret_cleanup", error }); }
      }
      state = failures.length ? "failed" : "stopped";
      for (const failure of failures) onError(failure);
      return snapshot();
    },
  };
}
