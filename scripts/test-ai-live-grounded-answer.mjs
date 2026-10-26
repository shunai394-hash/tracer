#!/usr/bin/env node
import assert from "node:assert/strict";
import { answerProductComment } from "../lib/ai-live/grounded-answer.mjs";

const product = {
  id: "test-1",
  title: "日本語テスト商品",
  description: "綿素材のテスト用説明",
  sellingPrice: 3980,
  currency: "JPY",
  inStock: true,
  productUrl: "https://tracer.base.ec/items/test-1",
};

const price = answerProductComment("いくらですか？", product);
assert.match(price.answer, /3,980円/);
assert.equal(price.grounded, true);

const stock = answerProductComment("在庫ありますか？", product);
assert.match(stock.answer, /在庫あり/);
assert.equal(stock.needsHuman, false);

const delivery = answerProductComment("明日届きますか？", product);
assert.match(delivery.answer, /確約できません/);
assert.equal(delivery.needsHuman, true);
assert.equal(delivery.grounded, false);

const details = answerProductComment("素材や特徴は？", product);
assert.match(details.answer, /綿素材のテスト用説明/);

const safeLink = answerProductComment("どこで買えますか？", product);
assert.match(safeLink.answer, /https:\/\/tracer\.base\.ec\/items\/test-1/);

const maliciousLink = answerProductComment("購入リンクをください", {
  ...product,
  productUrl: "https://example.com/fake",
});
assert.match(maliciousLink.answer, /安全に確認できません/);
assert.equal(maliciousLink.needsHuman, true);

const missingDescription = answerProductComment("サイズは？", { ...product, description: null });
assert.equal(missingDescription.needsHuman, true);

const missingPrice = answerProductComment("いくら？", { ...product, sellingPrice: 0 });
assert.equal(missingPrice.needsHuman, true);

console.log("AI-live grounded Japanese response tests: 8 cases passed");
