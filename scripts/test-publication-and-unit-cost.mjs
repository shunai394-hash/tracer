import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ERROR_HIDDEN_LEAVE,
  HIDDEN_DUPLICATE_DELETES,
  VISIBLE_ERROR_HIDES,
  VISIBLE_NONCANONICAL_HIDES,
  assessErrorHidden,
  assessHiddenDelete,
  classifyBaseDetailReadFailure,
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
  assert.equal(assessHiddenDelete(pair, visibleStale, pair.canonicalId).ok, false, "refuse if stale item became public");

  const wrongStaleSku = new Map([
    [pair.staleId, item(pair.staleId, "WRONG-SKU", false, pair.price)],
    [pair.canonicalId, item(pair.canonicalId, pair.sku, true, pair.price)],
  ]);
  assert.equal(assessHiddenDelete(pair, wrongStaleSku, pair.canonicalId).ok, false, "refuse stale SKU mismatch");

  const wrongStalePrice = new Map([
    [pair.staleId, item(pair.staleId, pair.sku, false, pair.price + 1)],
    [pair.canonicalId, item(pair.canonicalId, pair.sku, true, pair.price)],
  ]);
  assert.equal(assessHiddenDelete(pair, wrongStalePrice, pair.canonicalId).ok, false, "refuse stale price mismatch");

  const hiddenCanonical = new Map([
    [pair.staleId, item(pair.staleId, pair.sku, false, pair.price)],
    [pair.canonicalId, item(pair.canonicalId, pair.sku, false, pair.price)],
  ]);
  assert.equal(assessHiddenDelete(pair, hiddenCanonical, pair.canonicalId).ok, false, "refuse if canonical is not public");

  const wrongCanonicalSku = new Map([
    [pair.staleId, item(pair.staleId, pair.sku, false, pair.price)],
    [pair.canonicalId, item(pair.canonicalId, "WRONG-SKU", true, pair.price)],
  ]);
  assert.equal(assessHiddenDelete(pair, wrongCanonicalSku, pair.canonicalId).ok, false, "refuse canonical SKU mismatch");

  const wrongCanonicalPrice = new Map([
    [pair.staleId, item(pair.staleId, pair.sku, false, pair.price)],
    [pair.canonicalId, item(pair.canonicalId, pair.sku, true, pair.price + 1)],
  ]);
  assert.equal(assessHiddenDelete(pair, wrongCanonicalPrice, pair.canonicalId).ok, false, "refuse canonical price mismatch");
}
assert.equal(
  VISIBLE_ERROR_HIDES.some((target) => HIDDEN_DUPLICATE_DELETES.some((pair) => pair.canonicalId === target.itemId)),
  false,
  "a canonical item protected by duplicate deletion must not be hidden by the same repair",
);

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
const costApplyRoute = readFileSync(new URL("../app/api/admin/shopify/unit-cost/apply/route.ts", import.meta.url), "utf8");
assert.match(route, /REPAIR_TWO_REQUESTED_BASE_DUPLICATES/);
assert.match(route, /if \(!apply \|\| blocked\)/, "apply must refuse the entire repair when any preflight guard blocks");
assert.match(route, /const requestedDeletes = scoped/);
assert.match(route, /invalid_stale_ids/);
assert.match(route, /orderReferences\(actionIds\)/, "order scan must cover only the requested repair scope");
assert.match(route, /deleteAllowlistedStaleBaseItem/);
assert.doesNotMatch(route, /見つかりません/);
assert.doesNotMatch(route, /already_absent_verified/);
assert.match(route, /STALE_DETAIL_CONFLICT_WITH_SNAPSHOT/);
assert.equal(classifyBaseDetailReadFailure("BASE_ITEM_DETAIL_FAILED:HTTP_404:unknown_error"), "absent");
assert.equal(classifyBaseDetailReadFailure("BASE_ITEM_DETAIL_FAILED:HTTP_400:見つかりません"), "indeterminate");
assert.equal(classifyBaseDetailReadFailure("BASE_ITEM_DETAIL_FAILED:HTTP_400:invalid_request"), "indeterminate");
assert.equal(classifyBaseDetailReadFailure("BASE_ITEM_DETAIL_FAILED:HTTP_401:unauthorized"), "indeterminate");
assert.equal(classifyBaseDetailReadFailure("BASE_ITEM_DETAIL_FAILED:HTTP_403:forbidden"), "indeterminate");
assert.equal(classifyBaseDetailReadFailure("BASE_ITEM_DETAIL_FAILED:HTTP_500:internal_error"), "indeterminate");
assert.equal(classifyBaseDetailReadFailure("network timeout"), "indeterminate");
assert.match(route, /visible: false/);
assert.doesNotMatch(route, /visible:\s*true/);
assert.match(costRoute, /unitCost \{ amount currencyCode \}/);
assert.match(costRoute, /profitConfirmed: accessDenied \? false/);
assert.match(costApplyRoute, /confirmApply\?: boolean/, "unit-cost writes must require explicit confirmation");
assert.match(costApplyRoute, /APPLY_REQUIRES_EXPLICIT_VARIANT_IDS/, "writes must require an exact explicit variant selection");
assert.match(costApplyRoute, /requestedIds\.length > 100/, "writes must be bounded to 100 variants");
assert.match(costApplyRoute, /raw\.shippingKnown === true/, "shipping evidence must be explicit, not inferred");
assert.match(costApplyRoute, /sourceCurrency === "USD" && sourceUnitCost !== null && fxRate !== null && fxRate > 0/, "USD supplier cost must be converted only with a positive recorded FX rate");
assert.match(costApplyRoute, /Math\.round\(sourceUnitCost \* fxRate \* 100\) \/ 100/, "Shopify unit cost must be converted to JPY cents before write");
assert.match(costApplyRoute, /supplier_unit_cost_or_fx_rate_unverified/, "unsupported supplier currency or missing FX rate must block a cost write");
assert.match(costApplyRoute, /price_not_calculated_for_current_supplier_offer/, "profit must be calculated for the current supplier offer");
assert.match(costApplyRoute, /expectedProfitAtRecordedFx/, "unit-cost preflight must recalculate expected profit using the same recorded FX rate");
assert.match(costApplyRoute, /price_fx_does_not_match_supplier_cost_fx/, "unit-cost preflight must block profit records calculated with a different FX rate");
assert.match(costApplyRoute, /expectedProfit === null \|\| expectedProfit <= 0/, "non-positive profit must block a cost write");
assert.match(costApplyRoute, /APPLY_BLOCKED_BY_PREFLIGHT/, "any blocked selected variant must abort the entire apply");
assert.match(costApplyRoute, /inventoryItemUpdate\(id: \$id, input: \$input\)/, "cost write must use Shopify inventoryItemUpdate");
assert.match(costApplyRoute, /supplier_offers\(id,supplier_product_id,supplier_variant_id,unit_cost,currency,shipping_cost,source_status,inventory,raw_data,last_checked_at\)/, "supplier identity and verification fields must be read from the actual supplier_offers schema");
assert.doesNotMatch(costApplyRoute, /select\("id,supplier_product_id,supplier_variant_id,supplier_offers\(/, "do not select supplier identity columns that are absent from commerce_variants");
assert.match(costApplyRoute, /if \(!expectedSku \|\| !liveSku\) reasons\.push\("shopify_sku_missing"\)/, "missing or blank SKU on either side must block a cost write");
assert.match(costApplyRoute, /else if \(liveSku !== expectedSku\) reasons\.push\("shopify_sku_mismatch"\)/, "non-empty SKUs must match exactly after trimming");
assert.match(costApplyRoute, /amount === ev\.unitCost && currency === "JPY"/, "write is verified only after exact JPY readback");
assert.match(costApplyRoute, /listing\.status !== "published"/, "unit-cost writes must block listings not marked published in TRACER");
assert.match(costApplyRoute, /live\?\.product\?\.status !== "ACTIVE"/, "unit-cost writes must block non-active live Shopify products");
assert.match(costApplyRoute, /numeric\(live\?\.price\) !== ev\.sellingPrice/, "unit-cost writes must block when live Shopify price differs from the verified TRACER price");
assert.match(costApplyRoute, /shopify_unit_cost_conflict/, "unit-cost writes must block overwriting an existing different or non-JPY Shopify unit cost");

console.log("publication repair and unit cost: ok");
