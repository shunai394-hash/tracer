import assert from "node:assert/strict";
import { routeAiLiveComment } from "../lib/ai-live/comment-router.ts";

const cases = [
  ["いくらですか？", "price", "answer_from_verified_facts"],
  ["在庫ありますか？", "stock_or_variant", "answer_from_verified_facts"],
  ["明日届きますか？", "shipping", "answer_from_verified_facts"],
  ["どこで買えますか？", "purchase", "answer_from_verified_facts"],
  ["どんな商品ですか？", "product_faq", "answer_from_verified_facts"],
  ["注文番号123の配送状況を教えて", "order_support", "human_handoff"],
  ["返品したいです", "complaint_or_return", "human_handoff"],
  ["これで病気は治りますか？", "unknown", "human_handoff"],
  ["死ね", "spam_or_abuse", "ignore_or_moderate"],
  ["こんにちは", "unknown", "human_handoff"],
];

for (const [comment, category, action] of cases) {
  const result = routeAiLiveComment(comment);
  assert.equal(result.category, category, comment);
  assert.equal(result.action, action, comment);
  assert.ok(result.reason.length > 0);
}
assert.equal(routeAiLiveComment("").action, "human_handoff");
assert.equal(routeAiLiveComment(null).action, "human_handoff");
console.log(`AI-live comment router: ${cases.length + 2} assertions passed`);
