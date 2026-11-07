import assert from "node:assert/strict";
import {
  createCommentDeduplicator,
  normalizeTikTokAuthorizedComment,
  normalizeYouTubeLiveChatMessage,
} from "./normalize-comment.mjs";

const youtube = normalizeYouTubeLiveChatMessage({
  id: "yt-message-1",
  snippet: {
    type: "textMessageEvent",
    displayMessage: "  この商品の価格はいくらですか？  ",
    publishedAt: "2026-11-07T01:00:00Z",
  },
  authorDetails: {
    displayName: "must-not-be-forwarded",
    profileImageUrl: "https://example.invalid/avatar",
  },
});
assert.deepEqual(youtube, {
  id: "youtube_live:yt-message-1",
  platform: "youtube_live",
  text: "この商品の価格はいくらですか？",
  createdAt: "2026-11-07T01:00:00.000Z",
  kind: "text_comment",
});
assert.equal("author" in youtube, false);
assert.equal("authorDetails" in youtube, false);

assert.equal(normalizeYouTubeLiveChatMessage({
  id: "superchat-1",
  snippet: { type: "superChatEvent", displayMessage: "paid message", publishedAt: "2026-11-07T01:00:00Z" },
}), null);
assert.equal(normalizeYouTubeLiveChatMessage({
  id: "missing-time",
  snippet: { type: "textMessageEvent", displayMessage: "hello" },
}), null);

const tiktok = normalizeTikTokAuthorizedComment({
  source: "approved_tiktok_live_connector",
  commentId: "tt-comment-1",
  text: "色は何色ですか？",
  createdAt: "2026-11-07T01:01:00Z",
  user: { nickname: "must-not-be-forwarded" },
});
assert.deepEqual(tiktok, {
  id: "tiktok_live:tt-comment-1",
  platform: "tiktok_live",
  text: "色は何色ですか？",
  createdAt: "2026-11-07T01:01:00.000Z",
  kind: "text_comment",
});
assert.equal(normalizeTikTokAuthorizedComment({
  source: "unofficial_scraper",
  commentId: "tt-2",
  text: "hello",
  createdAt: "2026-11-07T01:01:00Z",
}), null);
assert.equal(normalizeTikTokAuthorizedComment({
  source: "approved_tiktok_live_connector",
  commentId: "tt-3",
  text: "   ",
  createdAt: "2026-11-07T01:01:00Z",
}), null);

const dedupe = createCommentDeduplicator({ maxEntries: 2 });
assert.equal(dedupe.accept(youtube), true);
assert.equal(dedupe.accept(youtube), false);
assert.equal(dedupe.accept(tiktok), true);
assert.equal(dedupe.size, 2);
assert.equal(dedupe.accept({ id: "new:3" }), true);
assert.equal(dedupe.size, 2);
assert.equal(dedupe.accept(youtube), true); // oldest key was evicted
assert.throws(() => createCommentDeduplicator({ maxEntries: 0 }), /maxEntries/);

console.log("AI Live normalized comment event contract: all assertions passed");
