import { test } from "node:test";
import assert from "node:assert/strict";
import { applyManualTitle, filterModifiersForCore, normalizeListingTitle, singleVariantColor } from "../lib/commerce/listing-title.ts";

test("beauty-tool modifiers are removed from bag titles", () => {
  assert.equal(normalizeListingTitle("レトロデザイン・眉メイク用 レディースショルダーバッグ"), "レトロデザイン レディースショルダーバッグ");
  assert.equal(normalizeListingTitle("大容量・眉メイク用 レディースハンドバッグ"), "大容量 レディースハンドバッグ");
  assert.equal(normalizeListingTitle("眉カット用 トリミングセット"), "眉カット用 トリミングセット");
  assert.equal(normalizeListingTitle("電動クリーナー 美容ケアツール"), "電動クリーナー 美容ケアツール");
});

test("colour conflicts and duplicated suffixes are resolved", () => {
  assert.equal(normalizeListingTitle("ブラック レディースショルダーバッグ（カーキ）"), "レディースショルダーバッグ（カーキ）");
  assert.equal(normalizeListingTitle("ブラック・ピンク レディースハンドバッグ（ブルー）"), "配色デザイン レディースハンドバッグ（ブルー）");
  assert.equal(normalizeListingTitle("レディース ハンドバッグ(ベージュ)（ベージュ）"), "レディース ハンドバッグ（ベージュ）");
  assert.equal(normalizeListingTitle("バッグ・収納アイテム(グレー)（グレー）"), "レディースバッグ（グレー）");
  assert.equal(normalizeListingTitle("ブラック 携帯用メイクブラシ10本セット"), "ブラック 携帯用メイクブラシ10本セット");
  assert.equal(normalizeListingTitle("コスメ ブラシ Cleaner"), "メイクブラシクリーナー");
});

test("importer helpers", () => {
  assert.deepEqual(filterModifiersForCore(["レトロデザイン", "眉メイク用"], "レディースショルダーバッグ"), ["レトロデザイン"]);
  assert.deepEqual(filterModifiersForCore(["眉メイク用"], "美容ケアツール"), ["眉メイク用"]);
  assert.equal(singleVariantColor(["ブラック", "ピンク"]), null);
  assert.equal(singleVariantColor(["ブラック"]), "ブラック");
});

test("manual titles keep each variant's suffix", () => {
  assert.equal(applyManualTitle("もこもこ素材 ハンドバッグ｜冬コーデのアクセントに", "ぬいぐるみ風素材 レディースハンドバッグ（オレンジ）"), "もこもこ素材 ハンドバッグ（オレンジ）｜冬コーデのアクセントに");
  assert.equal(applyManualTitle("寝ながらゆる巻き サテン ヒートレスカールロッド｜コテを使わないヘアアレンジに", "サテン調 ヒートレスカールロッド（寝ながらカール）"), "寝ながらゆる巻き サテン ヒートレスカールロッド｜コテを使わないヘアアレンジに");
  assert.equal(applyManualTitle("パール装飾 レディースバッグ（ホワイト）｜忘年会・パーティーの装いに", "x（ホワイト）"), "パール装飾 レディースバッグ（ホワイト）｜忘年会・パーティーの装いに");
});

import { freeShippingHtml, freeShippingText, FREE_SHIPPING_SENTENCE } from "../lib/commerce/listing-title.ts";

test("stacked importer category words collapse", () => {
  assert.equal(normalizeListingTitle("電動クリーナー・お手入れ用品 メイクブラシ・お手入れ用品（タイプD）"), "電動メイクブラシクリーナー（タイプD）");
  assert.equal(normalizeListingTitle("猫モチーフ・電動クリーナー メイクブラシ・お手入れ用品"), "猫モチーフ 電動メイクブラシクリーナー");
  assert.equal(normalizeListingTitle("メイクブラシ収納・お手入れ用品"), "メイクブラシ収納・お手入れ用品");
});

test("one free-shipping sentence replaces every older shipping line", () => {
  const legacy = "バッグです。\n\n日本向け送料：仕入先の送料見積もりは商品価格の計算に反映しています。最終的な配送費用は決済画面でご確認ください。";
  assert.equal(freeShippingText(legacy), "バッグです。\n\n" + FREE_SHIPPING_SENTENCE);
  assert.equal(freeShippingText("説明。\n\n" + FREE_SHIPPING_SENTENCE), "説明。\n\n" + FREE_SHIPPING_SENTENCE);
  assert.equal(freeShippingHtml("<p>本文</p>\n<p>" + FREE_SHIPPING_SENTENCE + "</p>"), null);
  const html = freeShippingHtml("バッグです。<br><br>日本向け送料：仕入先の送料見積もりは0円です。最終的な配送費用は決済画面でご確認ください。");
  assert.equal(html, "バッグです。\n<p>" + FREE_SHIPPING_SENTENCE + "</p>");
  assert.ok(!html.includes("決済画面"));
});
