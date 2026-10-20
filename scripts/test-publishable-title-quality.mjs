import test from "node:test";
import assert from "node:assert/strict";
import { isPublishableCatalogTitle } from "../lib/catalog/publishable-title.ts";

test("rejects generic fallback titles that are not product-specific", () => {
  for (const title of [
    "商品",
    "商品名未設定",
    "暮らしの便利アイテム",
    "ヘアケアアイテム",
    "バッグ・収納アイテム",
    "アクセサリー",
    "トレンド・美容アイテム",
  ]) {
    assert.equal(isPublishableCatalogTitle(title), false, `must reject generic title: ${title}`);
  }
});

test("accepts descriptive titles with product-specific detail", () => {
  for (const title of [
    "Maruki サイドクリップ付き ヘアアクセサリー",
    "折りたたみ式 防水トラベルバッグ",
    "USB充電式 ネイルケアセット",
  ]) {
    assert.equal(isPublishableCatalogTitle(title), true, `must accept descriptive title: ${title}`);
  }
});

test("rejects blank, overlong, and workflow/status titles", () => {
  assert.equal(isPublishableCatalogTitle("  "), false);
  assert.equal(isPublishableCatalogTitle("販売停止中の商品"), false);
  assert.equal(isPublishableCatalogTitle("商品 ".repeat(100)), false);
});

test("source-grounded CJ title rules cover observed generic hair, bag, and beauty products", async () => {
  const localization = await (await import("node:fs/promises")).readFile(
    new URL("../lib/intelligence/japanese-product.ts", import.meta.url),
    "utf8",
  );
  for (const title of [
    "漢服風 髪飾り・ヘアピンセット",
    "レディース 多層デザイン ヘアアクセサリー",
    "パール・ビーズ装飾 ヘアクリップ",
    "ジグザグ型 ヘアバンド 2本セット",
    "クリスタル装飾 4連ヘアクリップ",
    "バケット型 レディースショルダーバッグ",
    "ミニサイズ レディースバッグ",
    "ローラー式 フェイスケア美容器",
    "眉毛用 トリミングツール",
    "卓上 コスメ・小物収納ボックス",
  ]) {
    assert.match(localization, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("localizes observed mixed-language titles without retaining English words", async () => {
  const { localizeProductTitle } = await import("../lib/intelligence/japanese-product.ts");
  const cases = [
    ["New Large Capacity Laptop Handbag", "大容量 パソコン収納対応 レディースハンドバッグ"],
    ["Maruki Hair Accessories With Side Clips", "マルキ サイドクリップ付きヘアアクセサリー"],
    ["Black Bing Portable 10 Makeup Brushes Suit Beauty Tools", "ブラック 携帯用メイクブラシ10本セット"],
    ["Large-capacity Hanging Makeup Organizer Bag", "大容量 吊り下げ式メイク収納バッグ"],
    ["Portable Pill Makeup Travel Organizer", "携帯用 メイク用品トラベル収納ケース"],
    ["5 Pcs Beauty Tools Portable Makeup Brush", "携帯用メイクブラシ5本セット"],
    ["Wooden Handle Soft Hair Makeup Brush Set Beauty Tools", "木製ハンドル メイクブラシセット"],
    ["PU Leather Headband Gel Women Ponytail Clip Decoration Hair Accessories", "レザー調ヘッドバンド付きポニーテールクリップ"],
    ["Powder Cosmetic Brush Beauty Tools Are Portable", "携帯用パウダーメイクブラシ"],
    ["Acne Removal 8 Pieces Suit Beauty Tools Pimple Pin", "ニキビケア用ピンセット8点セット"],
    ["10PCS Beauty Tools Novice Makeup Brush Set", "初心者向けメイクブラシ10本セット"],
    ["Makeup Brush Set 15 Multi-color Beauty Tools", "多色メイクブラシ15本セット"],
    ["12 Makeup Brushes Set Beauty Tools", "メイクブラシ12本セット"],
    ["Fiber Hair Brush Beauty Makeup Tools", "繊維毛ヘアブラシ"],
    ["20-Piece Makeup Brush Set Beauty Tools", "メイクブラシ20本セット"],
    ["Bridal Jewelry Wedding Hair Accessories Accessories Necklace And Earrings Suite Women", "ブライダル用ネックレス・ピアス・ヘアアクセサリーセット"],
    ["Fashion Portable Makeup Brush Beauty Tools", "携帯用メイクブラシ"],
    ["Brushes Suit Beauty Tools Makeup Eyeshadow Brush Set Suit", "アイシャドウ用メイクブラシセット"],
    ["12 Pcs Makeup Brush Set Soft Hair Beauty Tools", "柔らか毛メイクブラシ12本セット"],
    ["Mini Beauty Egg Small Makeup tools", "卵型コンパクトメイクスポンジ"],
  ];
  for (const [source, expected] of cases) {
    const localized = localizeProductTitle(source);
    assert.equal(localized, expected, source);
    assert.doesNotMatch(localized, /[A-Za-z]{2,}/, source + " must not retain English words");
  }
});
