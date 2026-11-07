const YOUTUBE_LIVE_CHAT_MESSAGES_URL = "https://www.googleapis.com/youtube/v3/liveChat/messages";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 120_000;

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Official YouTube Data API v3 liveChatMessages.list transport.
 *
 * The host supplies an access-token provider so OAuth refresh and secret
 * storage stay outside this worker module. The provider must return a current
 * bearer token for the connected channel. No token is persisted or logged here.
 *
 * Yields the same page shape consumed by createYouTubeLiveChatAdapter:
 * { items, nextPageToken }. The API's pollingIntervalMillis is respected.
 */
export function createYouTubeLiveChatListTransport({
  accessTokenProvider,
  fetchImpl = fetch,
  maxResults = 2000,
} = {}) {
  if (typeof accessTokenProvider !== "function" || typeof fetchImpl !== "function") {
    throw new Error("youtube_access_token_provider_and_fetch_required");
  }
  if (!Number.isInteger(maxResults) || maxResults < 200 || maxResults > 2000) {
    throw new Error("youtube_live_chat_max_results_out_of_range");
  }

  return async function* streamList({ liveChatId, pageToken, signal } = {}) {
    if (typeof liveChatId !== "string" || !liveChatId.trim() || liveChatId.length > 256) {
      throw new Error("invalid_youtube_live_chat_id");
    }
    if (!signal || typeof signal.aborted !== "boolean") {
      throw new Error("youtube_live_chat_abort_signal_required");
    }

    let resumeToken = typeof pageToken === "string" && pageToken ? pageToken : null;
    while (!signal.aborted) {
      const accessToken = await accessTokenProvider({ signal });
      if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192) {
        throw new Error("youtube_oauth_access_token_unavailable");
      }

      const url = new URL(YOUTUBE_LIVE_CHAT_MESSAGES_URL);
      url.searchParams.set("part", "id,snippet,authorDetails");
      url.searchParams.set("liveChatId", liveChatId);
      url.searchParams.set("maxResults", String(maxResults));
      if (resumeToken) url.searchParams.set("pageToken", resumeToken);

      const response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: "Bearer " + accessToken, accept: "application/json" },
        signal,
      });
      if (!response?.ok) {
        const status = Number.isInteger(response?.status) ? response.status : 0;
        throw new Error("youtube_live_chat_api_http_" + status);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("youtube_live_chat_api_invalid_json");
      }
      if (!payload || !Array.isArray(payload.items) || typeof payload.nextPageToken !== "string" ||
          !payload.nextPageToken) {
        throw new Error("youtube_live_chat_api_invalid_response");
      }

      resumeToken = payload.nextPageToken;
      yield { items: payload.items, nextPageToken: resumeToken };

      const requestedDelay = Number.isFinite(payload.pollingIntervalMillis) && payload.pollingIntervalMillis > 0
        ? payload.pollingIntervalMillis
        : DEFAULT_POLL_INTERVAL_MS;
      const delayMs = Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, requestedDelay));
      await wait(delayMs, signal);
    }
  };
}
