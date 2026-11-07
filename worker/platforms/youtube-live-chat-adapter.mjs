import { normalizeYouTubeLiveChatMessage } from "./normalize-comment.mjs";

const MAX_RECONNECTS = 8;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * streamList must be backed by the official YouTube Live Streaming API
 * liveChatMessages.streamList transport and yield response pages:
 * { items: [...], nextPageToken: "..." }.
 */
export function createYouTubeLiveChatAdapter({
  streamList,
  onComment,
  onError = () => {},
  maxReconnects = MAX_RECONNECTS,
  baseDelayMs = BASE_DELAY_MS,
  maxDelayMs = MAX_DELAY_MS,
} = {}) {
  if (typeof streamList !== "function" || typeof onComment !== "function") {
    throw new Error("youtube_stream_list_and_on_comment_required");
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
  let lastPageToken = null;
  let liveChatId = null;
  let onCommentHandler = onComment;

  async function run(signal) {
    state = "connecting";
    while (!signal.aborted) {
      try {
        const pages = await streamList({ liveChatId, pageToken: lastPageToken, signal });
        if (!pages || typeof pages[Symbol.asyncIterator] !== "function") {
          throw new Error("youtube_stream_list_must_return_async_iterable");
        }
        state = "connected";
        for await (const page of pages) {
          if (signal.aborted) break;
          if (!page || typeof page !== "object") continue;
          if (typeof page.nextPageToken === "string" && page.nextPageToken) {
            lastPageToken = page.nextPageToken;
          }
          for (const message of Array.isArray(page.items) ? page.items : []) {
            const event = normalizeYouTubeLiveChatMessage(message);
            if (event) {
              try { await onCommentHandler(event); } catch (error) { onError(error); }
            }
          }
        }
        if (signal.aborted) break;
        throw new Error("youtube_chat_stream_ended");
      } catch (error) {
        if (signal.aborted) break;
        if (error?.name === "AbortError") break;
        if (reconnectCount >= maxReconnects) {
          state = "failed";
          onError(error);
          return;
        }
        reconnectCount += 1;
        state = "reconnecting";
        onError(error);
        const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** (reconnectCount - 1)));
        try { await wait(delay, signal); } catch { break; }
      }
    }
    if (state !== "failed") state = "stopped";
  }

  return {
    snapshot() {
      return { state, reconnectCount, hasResumeToken: Boolean(lastPageToken) };
    },
    setOnComment(handler) {
      if (typeof handler !== "function") throw new Error("on_comment_handler_required");
      if (task) throw new Error("cannot_replace_comment_handler_while_started");
      onCommentHandler = handler;
    },
    async start(id) {
      if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("invalid_youtube_live_chat_id");
      if (task) throw new Error("youtube_chat_adapter_already_started");
      liveChatId = id;
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
