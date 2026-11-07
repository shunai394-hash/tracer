import { createTracerspeechBridge } from "../platforms/tracer-speech-bridge.mjs";
import { createFfmpegPublisher } from "./ffmpeg-publisher.mjs";
import { createAiLiveMediaSession } from "./live-media-session.mjs";
import { createAiLiveStreamRuntime } from "./ai-live-stream-runtime.mjs";

/**
 * Builds the concrete speech -> FFmpeg -> reconnect chain. Unexpected FFmpeg
 * exits feed the bounded reconnect supervisor automatically.
 */
export function createAiLiveMediaRuntime({
  secretResolver,
  speechBridge = createTracerspeechBridge(),
  mediaRoot,
  ffmpegPath,
  spawnImpl,
  maxRetries = 8,
  baseDelayMs = 2_000,
  maxDelayMs = 60_000,
  sleep,
  onState,
} = {}) {
  let runtime = null;
  const publisher = createFfmpegPublisher({
    secretResolver,
    ...(mediaRoot ? { mediaRoot } : {}),
    ...(ffmpegPath ? { ffmpegPath } : {}),
    ...(spawnImpl ? { spawnImpl } : {}),
    onDisconnected: ({ reason, retryable }) => {
      if (!retryable || !runtime) return;
      void Promise.resolve(runtime.notifyDisconnected(reason)).catch(() => {});
    },
  });
  const mediaSession = createAiLiveMediaSession({ publisher, speechBridge });
  runtime = createAiLiveStreamRuntime({
    mediaSession,
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    ...(sleep ? { sleep } : {}),
    ...(onState ? { onState } : {}),
  });
  return runtime;
}
