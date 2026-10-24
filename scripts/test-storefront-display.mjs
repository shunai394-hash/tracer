import assert from "node:assert/strict";
import { categoryOf, variantFamily, pickDistinct } from "../lib/shop/storefront-display.ts";

const categoryCases = [
  ["ニキビケア用ピンセット8点セット（4ピン・No.5斜めクリップ）", "makeup"],
  ["メイクブラシ収納ポーチ", "makeup"],
  ["レディースハンドバッグ（ブラック）", "bags"],
  ["バンスクリップ ヘアアクセサリー", "hair"],
  ["シンプルなヘアゴム", "hair"],
  ["暮らしの小物", "other"],
];

for (const [title, expected] of categoryCases) {
  assert.equal(categoryOf(title), expected, `categoryOf(${title})`);
}

assert.equal(
  variantFamily("レディースハンドバッグ（ブラック）"),
  variantFamily("レディースハンドバッグ（ピンク）"),
  "known colour variants should share a display family",
);
assert.notEqual(
  variantFamily("ポーチ（2個セット）"),
  variantFamily("ポーチ（3個セット）"),
  "different set sizes must not be collapsed as colour variants",
);
assert.notEqual(
  variantFamily("ブラシ（5本セット）"),
  variantFamily("ブラシ（10本セット）"),
  "different bundle sizes must remain distinct",
);

const listing = (id, title, imageUrl = "https://example.com/image.jpg") => ({
  id, title, imageUrl, sellingPrice: 1000, currency: "JPY", inventory: 5,
});
const selected = pickDistinct([
  listing("1", "ハンドバッグ（ブラック）"),
  listing("2", "ハンドバッグ（ピンク）"),
  listing("3", "ショルダーバッグ"),
  listing("4", "画像なし商品", null),
], 8);
assert.deepEqual(selected.map((item) => item.id), ["1", "3"]);
console.log("Storefront display checks passed.");
