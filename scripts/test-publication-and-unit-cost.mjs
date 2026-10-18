import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ERROR_HIDDEN_LEAVE,
  HIDDEN_DUPLICATE_DELETES,
  VISIBLE_ERROR_HIDES,
  VISIBLE_NONCANONICAL_HIDES,
  assessErrorHidden,
  assessHiddenDelete,
  assessVisibleErrorHide,
  assessVisibleHide,
} from "../lib/channels/base-publication-repair.ts";
import { judgeUnitCost } from "../lib/shopify/unit-cost-reconcile.ts";
import { appendSnapshotRows, prepareSnapshotResume } from "../lib/channels/base-snapshot-checkpoint.ts";

function item(id, sku, visible, price) {
  return { itemId: id, sku, visible, price };
}

const first = HIDDEN_DUPLICATE_DELETES[0];
const items = new Map([
  [first.staleId, item(first.staleId, first.sku, false, first.price)],
  [first.canonicalId, item(first.canonicalId, first.sku, true, first.price)],
]);
assert.equal(assessHiddenDelete(first, items, first.canonicalId).ok, true);
assert.equal(assessHiddenDelete(first, items, first.staleId).ok, false);

assert.equal(VISIBLE_NONCANONICAL_HIDES.length, 0);
for (const staleId of ["163159679", "163159245"]) {
  const pair = HIDDEN_DUPLICATE_DELETES.find((candidate) => candidate.staleId === staleId);
  assert.ok(pair, `missing delete allowlist entry for ${staleId}`);
  const validItems = new Map([
    [pair.staleId, item(pair.staleId, pair.sku, false, pair.price)],
    [pair.canonicalId, item(pair.canonicalId, pair.sku, true, pair.price)],
  ]);
  assert.equal(assessHiddenDelete(pair, validItems, pair.canonicalId).ok, true);
  assert.equal(assessHiddenDelete(pair, validItems, pair.staleId).ok, false);
  const visibleStale = new Map([
    [pair.staleId, item(pair.staleId, pair.sku, true, pair.price)],
    [pair.canonicalId, item(pair.canonicalId, pair.sku, true, pair.price)],
  ]);
  assert.equal(assessHiddenDelete(pair, visibleStale, pair.canonicalId).ok, false);
}

const errorItem = ERROR_HIDDEN_LEAVE[0];
const errorItems = new Map([[errorItem.itemId, item(errorItem.itemId, errorItem.sku, false, errorItem.price)]]);
const visibleError = VISIBLE_ERROR_HIDES[0];
assert.equal(assessVisibleErrorHide(visibleError, new Map([[visibleError.itemId, item(visibleError.itemId, visibleError.sku, true, visibleError.price)]]), { externalId: visibleError.itemId, status: "error" }).action, "hide_visible_error_listing");
assert.equal(assessErrorHidden(errorItem, errorItems, { externalId: errorItem.itemId, status: "error" }).action, "leave_db_error_base_already_hidden");
assert.equal(assessErrorHidden(errorItem, errorItems, { externalId: errorItem.itemId, status: "published" }).ok, false);

const confirmed = judgeUnitCost({
  shopifyUnitCost: 100, shopifyCurrency: "JPY", supplierUnitCost: 100, supplierCurrency: "JPY",
  shippingCost: 20, shippingKnown: true, sellingPrice: 1000, expectedProfit: 400, priceCurrency: "JPY",
});
assert.equal(confirmed.profitConfirmed, true);
const missingShopifyCost = judgeUnitCost({ ...{
  shopifyUnitCost: null, shopifyCurrency: null, supplierUnitCost: 100, supplierCurrency: "JPY",
  shippingCost: 20, shippingKnown: true, sellingPrice: 1000, expectedProfit: 400, priceCurrency: "JPY",
} });
assert.equal(missingShopifyCost.costConfirmed, false);
assert.equal(missingShopifyCost.profitConfirmed, false);
assert.ok(missingShopifyCost.reasons.includes("shopify_unit_cost_missing"));

const prior = [{ item_id: "1", price: 10 }];
const resumed = prepareSnapshotResume(prior, { nextOffset: 100, pagesFetched: 1, itemIds: ["1"] });
const again = appendSnapshotRows(resumed.items, resumed.seen, [{ item_id: "1", price: 99 }, { item_id: "2", price: 20 }]);
assert.deepEqual(again, { added: 1, duplicates: 1 });
assert.equal(resumed.items.length, 2);
assert.equal(resumed.items[0].price, 10);

const route = readFileSync(new URL("../app/api/channels/base/publication-repair/route.ts", import.meta.url), "utf8");
const costRoute = readFileSync(new URL("../app/api/admin/shopify/unit-cost/route.ts", import.meta.url), "utf8");
assert.match(route, /REPAIR_BASE_PUBLICATION_MISMATCHES_AND_HIDDEN_DUPLICATES/);
assert.match(route, /deleteAllowlistedStaleBaseItem/);
assert.match(route, /見つかりません/);
assert.match(route, /already_absent_verified/);
assert.match(route, /visible: false/);
assert.doesNotMatch(route, /visible:\s*true/);
assert.match(costRoute, /unitCost \{ amount currencyCode \}/);
assert.match(costRoute, /profitConfirmed: accessDenied \? false/);
console.log("publication repair and unit cost: ok");
