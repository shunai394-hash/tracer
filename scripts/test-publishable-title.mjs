import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isPublishableCatalogTitle } from "../lib/catalog/publishable-title.ts";

const cases = [
  ["ordinary Japanese product title", "折りたたみ収納ボックス", true],
  ["identity failure suffix", "暮らしの便利アイテム 商品アイデンティティが未確定のため、選定対象外", false],
  ["sales gate failure suffix", "ペット用品 必須ゲートを満たしていないため、テスト優先度は低い", false],
  ["truncated evidence suffix", "スマホケース は観測された需要と供給データに基", false],
  ["sales candidate explanation suffix", "マスカラ 防水 Super Long は観測された需要と供給データに基づいて販売テスト候補になる", false],
  ["placeholder trend title", "トレンド・seeded_dueアイテム", false],
  ["generic specification placeholder", "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。", false],
  ["empty title", "", false],
  ["non-string title", null, false],
  ["overlong title", "a".repeat(181), false],
];
for (const [name, title, expected] of cases) {
  assert.equal(isPublishableCatalogTitle(title), expected, name);
}

const shopify = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
const base = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
assert.match(shopify, /isPublishableCatalogTitle\(row\.title\)/, "Shopify sync must enforce publishable title guard");
assert.match(shopify, /catalog_title_not_publishable/, "Shopify sync must report title block reason");
assert.match(base, /isPublishableCatalogTitle\(sourceTitle\)/, "BASE must reject invalid source titles");
assert.match(base, /isPublishableCatalogTitle\(translatedTitle\)/, "BASE must reject invalid translated titles");
assert.match(base, /base_hide_failed_after_catalog_validation/, "BASE hide failure must be surfaced");
assert.match(store, /isPublishableCatalogTitle\(listing\.title\)/, "storefront must filter invalid titles");
assert.match(store, /listing title failed catalog quality gate/, "order placement must revalidate title quality");
console.log(`Catalog title quality tests: ${cases.length} title cases + 5 channel wiring checks passed.`);
