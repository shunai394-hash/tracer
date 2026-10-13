import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "../lib/catalog/publishable-title.ts";
import { localizeProductDescription, localizeProductTitle } from "../lib/intelligence/japanese-product.ts";

const cases = [
  ["ordinary Japanese product title", "折りたたみ収納ボックス", true],
  ["generic category-only bathroom title", "バスルームマット", false],
  ["generic category-only kitchen title", "キッチン用品", false],
  ["descriptive bathroom mat title", "吸盤付き ノンスリップ バスマット", true],
  ["descriptive kitchen product title", "キッチン用品 収納ラック", true],
  ["identity failure suffix", "暮らしの便利アイテム 商品アイデンティティが未確定のため、選定対象外", false],
  ["sales gate failure suffix", "ペット用品 必須ゲートを満たしていないため、テスト優先度は低い", false],
  ["truncated evidence suffix", "スマホケース は観測された需要と供給データに基", false],
  ["sales candidate explanation suffix", "マスカラ 防水 Super Long は観測された需要と供給データに基づいて販売テスト候補になる", false],
  ["placeholder trend title", "トレンド・seeded_dueアイテム", false],
  ["generic specification placeholder", "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。", false],
  ["empty title", "", false],
  ["non-string title", null, false],
  ["overlong title", "a".repeat(181), false],
  ["description placeholder", "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。", false],
  ["description placeholder with shipping suffix", "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。 日本向け配送：送料別。", false],
  ["specific product description", "収納ボックス。折りたたみ式で、使わない時は薄く収納できます。", true],
  ["empty description", "", false],
];
for (const [name, title, expected] of cases) {
  if (name.includes("description")) {
    assert.equal(isPublishableCatalogDescription(title), expected, name);
  } else {
    assert.equal(isPublishableCatalogTitle(title), expected, name);
  }
}

assert.equal(localizeProductTitle("Simple Oil Wax Leather Messenger Shoulder Bags Women's High Capacity Portable Tote Bag"), "レディース ショルダーバッグ");
assert.equal(localizeProductTitle("Portable Cosmetic Bag Waterproof Divider Multi-grid Pockets Toiletry Bags Travel Storage Handbags Women Make Up Bag"), "仕切り付き コスメポーチ");
assert.equal(localizeProductTitle("Bohemian Beach Vacation Flower Hair Clip For Women Fashion Girl Accessories Gift"), "フラワーモチーフ ヘアクリップ");
assert.equal(localizeProductTitle("Groin Electric Clippers Household Hair Clipper (Groin Electric Clippers Household Hair Clipper Black Cutter head)"), "デリケートゾーン用 電動トリマー");
assert.equal(localizeProductTitle("Art Design Graffiti Art Hip Hop African Girl with Black Hair Big Earring with Modern Building Shower Curtain for Bathroom Decor"), "アフリカンアート柄 シャワーカーテン");
assert.equal(isPublishableCatalogTitle("トレンド・beautyアイテム"), false);
assert.equal(isPublishableCatalogTitle("アフリカンアート柄 シャワーカーテン"), true);
const supplySelector = await readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8");
assert.match(supplySelector, /isPublishableCatalogTitle\(localizedTitle\)/, "supply publication must enforce buyer-facing title quality");
assert.match(localizeProductDescription("Bohemian Beach Vacation Flower Hair Clip For Women"), /花モチーフのヘアクリップ/);
 
const shopify = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const base = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(shopify, /isPublishableCatalogTitle\(row\.title\)/, "Shopify sync must enforce publishable title guard");
assert.match(shopify, /catalog_title_not_publishable/, "Shopify sync must report title block reason");
assert.match(shopify, /isPublishableCatalogDescription\(row\.description\)/, "Shopify sync must reject generic descriptions");
assert.match(base, /isPublishableCatalogTitle\(sourceTitle\)/, "BASE must reject invalid source titles");
assert.match(base, /isPublishableCatalogTitle\(translatedTitle\)/, "BASE must reject invalid translated titles");
assert.match(base, /isPublishableCatalogDescription\(sourceDetail\)/, "BASE must reject generic source descriptions");
assert.match(base, /isPublishableCatalogDescription\(translatedDetail\)/, "BASE must reject generic translated descriptions");
assert.match(base, /base_hide_failed_after_catalog_validation/, "BASE hide failure must be surfaced");
assert.match(base, /identityUnlinkedIds\.has\(listingId\).*base_last_error.*listing\.base_item_id && listing\.published !== true/s, "BASE must keep unlinked and already-hidden rows out of the publish path");
assert.match(store, /isPublishableCatalogTitle\(listing\.title\)/, "storefront must filter invalid titles");
assert.match(store, /isPublishableCatalogDescription\(listing\.description\)/, "storefront must filter generic descriptions");
assert.match(store, /listing title failed catalog quality gate/, "order placement must revalidate title quality");
console.log(`Catalog title/description quality tests: ${cases.length} cases + 18 channel wiring/title-quality checks passed.`);
