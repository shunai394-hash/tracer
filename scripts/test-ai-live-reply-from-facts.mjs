import assert from "node:assert/strict";
import { buildAiLiveReply } from "../lib/ai-live/reply-from-facts.ts";

const product = {
  title: "日本語のデモ商品",
  description: "登録済みの商品説明です。",
  sellingPrice: 2980,
  currency: "JPY",
  inStock: true,
  productUrl: "https://tracer.base.ec/items/12345",
};

assert.match(buildAiLiveReply("price", product).text, /2,980円/u);
assert.match(buildAiLiveReply("stock_or_variant", product).text, /在庫あり/u);
assert.match(buildAiLiveReply("purchase", product).text, /https:\/\/tracer\.base\.ec\/items\/12345/u);
assert.match(buildAiLiveReply("product_faq", product).text, /登録済みの商品説明/u);
assert.deepEqual(buildAiLiveReply("shipping", product), {
  action: "human_handoff",
  reason: "delivery_estimate_not_available",
});
assert.deepEqual(buildAiLiveReply("order_support", product), {
  action: "human_handoff",
  reason: "category_not_approved_for_auto_reply",
});
assert.deepEqual(buildAiLiveReply("product_faq", { ...product, description: null }), {
  action: "human_handoff",
  reason: "verified_description_unavailable",
});
console.log("AI-live verified reply tests passed (7 assertions).");
