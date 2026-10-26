#!/usr/bin/env node
/**
 * Local-only AI-live rehearsal. No network, credentials, DB, or commerce writes.
 * Uses a clearly synthetic product fixture and canned grounded responses.
 */
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
  switch (comment.type) {
    case "price":
      return `こちらは動作確認用の架空商品で、表示価格は${item.sellingPrice.toLocaleString("ja-JP")}円です。`;
    case "features":
      return item.description;
    case "availability":
      return "このデモでは在庫ありとして応答しています。実商品の在庫状況は確認していません。";
    case "purchase":
      return `購入先の表示例はこちらです。${item.productUrl}`;
    default:
      return "お届け予定日はこのデモでは確認できません。実際の商品ページでご確認ください。";
  }
}

const startedAt = Date.now();
const results = comments.map((comment) => {
  const before = Date.now();
  const answer = answerFor(comment, product);
  return {
    commentType: comment.type,
    comment: comment.text,
    answer,
    simulatedLatencyMs: Date.now() - before,
    spokenAudio: false,
    note: "音声合成・アバター駆動は未接続",
  };
});

const report = {
  mode: "local-only",
  demoOnly: true,
  networkAccess: false,
  databaseAccess: false,
  commerceWrites: false,
  publicStreaming: false,
  product,
  commentCount: results.length,
  elapsedMs: Date.now() - startedAt,
  results,
};

console.log(JSON.stringify(report, null, 2));
