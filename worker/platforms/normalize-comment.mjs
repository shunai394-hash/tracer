const MAX_COMMENT_CHARS = 2000;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(CONTROL_CHARS, "").trim().slice(0, MAX_COMMENT_CHARS);
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/**
 * Convert platform-native messages into the shared, privacy-minimized event.
 * Author names, avatars, profile URLs, and payment metadata are deliberately omitted.
 */
export function normalizeYouTubeLiveChatMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const snippet = message.snippet;
  if (!snippet || typeof snippet !== "object") return null;
  if (snippet.type !== "textMessageEvent") return null;
  const text = cleanText(snippet.displayMessage ?? snippet.textMessageDetails?.messageText);
  const timestamp = isoTimestamp(snippet.publishedAt);
  if (!text || !timestamp || typeof message.id !== "string" || !message.id) return null;
  return {
    id: "youtube_live:" + message.id,
    platform: "youtube_live",
    text,
    createdAt: timestamp,
    kind: "text_comment",
  };
}

/**
 * TikTok comments may enter only through a platform-authorized integration.
 * The official Research API's video-comment endpoint is not a real-time LIVE chat API.
 */
export function normalizeTikTokAuthorizedComment(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  if (event.source !== "approved_tiktok_live_connector") return null;
  const text = cleanText(event.text);
  const timestamp = isoTimestamp(event.createdAt);
  if (!text || !timestamp || typeof event.commentId !== "string" || !event.commentId) return null;
  return {
    id: "tiktok_live:" + event.commentId,
    platform: "tiktok_live",
    text,
    createdAt: timestamp,
    kind: "text_comment",
  };
}

export function createCommentDeduplicator({ maxEntries = 5000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 50000) {
    throw new Error("maxEntries must be an integer between 1 and 50000");
  }
  const seen = new Map();
  return {
    accept(event) {
      if (!event || typeof event.id !== "string" || !event.id) return false;
      if (seen.has(event.id)) return false;
      seen.set(event.id, true);
      if (seen.size > maxEntries) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}
