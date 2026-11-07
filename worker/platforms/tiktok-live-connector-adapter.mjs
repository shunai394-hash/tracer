import { normalizeTikTokAuthorizedComment } from "./normalize-comment.mjs";

const MAX_RECONNECTS = 8;

/**
 * connector.connect must be an explicitly approved TikTok LIVE connector and
 * return an AsyncIterable of connector events. This module does not scrape
 * TikTok or implement undocumented endpoints.
 */
export function createTikTokLiveConnectorAdapter({
  connector,
  onComment,
  onError = () => {},
  maxReconnects = MAX_RECONNECTS,
  baseDelayMs = 500,
  maxDelayMs = 15_000,
} = {}) {
  if (!connector || typeof connector.connect !== "function" || typeof onComment !== "function") {
    throw new Error("approved_tiktok_connector_and_on_comment_required");
  }
  if (!Number.isInteger(maxReconnects) || maxReconnects < 0 || maxReconnects > 20 ||
      !Number.isInteger(baseDelayMs) || baseDelayMs < 1 ||
      !Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new Error("invalid_reconnect_policy");
  }

  let controller = null;
  let task = null;
  let state = "idle";
  let reconnectCount = 0;

  const delay = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });

  async function run(signal) {
    state = "connecting";
    while (!signal.aborted) {
      try {
        const events = await connector.connect({ signal });
        if (!events || typeof events[Symbol.asyncIterator] !== "function") {
          throw new Error("approved_tiktok_connector_must_return_async_iterable");
        }
        state = "connected";
        for await (const raw of events) {
          if (signal.aborted) break;
          const event = normalizeTikTokAuthorizedComment(raw);
          if (event) {
            try { await onComment(event); } catch (error) { onError(error); }
          }
        }
        if (signal.aborted) break;
        throw new Error("tiktok_live_connector_ended");
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") break;
        if (reconnectCount >= maxReconnects) {
          state = "failed";
          onError(error);
          return;
        }
        reconnectCount += 1;
        state = "reconnecting";
        onError(error);
        const ms = Math.min(maxDelayMs, baseDelayMs * (2 ** (reconnectCount - 1)));
        try { await delay(ms, signal); } catch { break; }
      }
    }
    if (state !== "failed") state = "stopped";
  }

  return {
    snapshot() { return { state, reconnectCount }; },
    async start() {
      if (task) throw new Error("tiktok_connector_already_started");
      controller = new AbortController();
      task = run(controller.signal);
      return this.snapshot();
    },
    async stop() {
      if (!controller) return this.snapshot();
      controller.abort();
      await task;
      controller = null;
      task = null;
      if (state !== "failed") state = "stopped";
      return this.snapshot();
    },
  };
}
