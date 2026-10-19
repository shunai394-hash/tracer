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
