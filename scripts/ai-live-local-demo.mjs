#!/usr/bin/env node
/**
 * Local-only AI-live rehearsal. No network, credentials, DB, or commerce writes.
 * Uses the same deterministic router and reply builder as the protected API,
 * with a clearly synthetic product fixture.
 */
import { routeAiLiveComment } from "../lib/ai-live/comment-router.ts";
import { buildAiLiveReply } from "../lib/ai-live/reply-from-facts.ts";

const product = Object.freeze({
  id: "LOCAL-DEMO-001",
  title: "デモ商品（架空データ）",
  description: "これは配信動作確認用の架空商品です。実在の商品情報ではありません。",
  sellingPrice: 2980,
  currency: "JPY",
  inStock: true,
  productUrl: "https://tracer.base.ec/",
  updatedAt: new Date().toISOString(),
  demoOnly: true,
});

const comments = [
  { type: "price", text: "いくらですか？" },
  { type: "features", text: "どんな商品ですか？" },
  { type: "availability", text: "在庫ありますか？" },
  { type: "purchase", text: "どこで買えますか？" },
  { type: "unknown", text: "明日届きますか？" },
];

function answerFor(comment, item) {
  const route = routeAiLiveComment(comment.text);
  const reply = buildAiLiveReply(route.category, {
    title: item.title,
    description: item.description,
    sellingPrice: item.sellingPrice,
    currency: item.currency,
    inStock: item.inStock,
    productUrl: item.productUrl,
  });
  return {
    route,
    answer: reply.action === "speak_verified_reply"
      ? reply.text
      : "お届け予定日はこのデモでは確認できません。実際の商品ページでご確認ください。",
    replyAction: reply.action,
    replyReason: reply.action === "human_handoff" ? reply.reason : null,
  };
}

const startedAt = Date.now();
const results = comments.map((comment) => {
  const before = Date.now();
  const result = answerFor(comment, product);
  return {
    commentType: comment.type,
    comment: comment.text,
    category: result.route.category,
    routeAction: result.route.action,
    replyAction: result.replyAction,
    replyReason: result.replyReason,
    answer: result.answer,
    simulatedLatencyMs: Date.now() - before,
    spokenAudio: false,
    note: "共有ルーターと返信生成を使用。音声合成・アバター駆動・公開配信は未接続",
  };
});

const report = {
  mode: "local-only",
  demoOnly: true,
  networkAccess: false,
  databaseAccess: false,
  commerceWrites: false,
  publicStreaming: false,
  sharedProductionLogic: true,
  product,
  commentCount: results.length,
  elapsedMs: Date.now() - startedAt,
  results,
};

console.log(JSON.stringify(report, null, 2));
