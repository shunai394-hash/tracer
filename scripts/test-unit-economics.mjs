import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { summarizeUnitEconomics, unitEconomics } from "../lib/commerce/unit-economics.ts";

let cases = 0;
const check = (name, fn) => { fn(); cases += 1; };
const row = (patch = {}) => ({
  variantId: "v1", title: "t", sellingPrice: 4000, feeAmount: 200, expectedProfit: 2000,
  inventory: 5, offerFresh: true, liveOnShopify: true, liveOnBase: true, ...patch,
});

check("break-even ROAS is price / profit and max CPA is the profit", () => {
  const result = unitEconomics(row());
  assert.equal(result.breakEvenRoas, 2);
  assert.equal(result.maxCpaJpy, 2000);
  assert.equal(result.supplierCostAndShipping, 1800);
  assert.equal(result.marginRate, 0.5);
});
check("rows without positive price or profit are never scored", () => {
  assert.equal(unitEconomics(row({ expectedProfit: 0 })), null);
  assert.equal(unitEconomics(row({ sellingPrice: 0 })), null);
  assert.equal(unitEconomics(row({ expectedProfit: 5000 })), null);
  assert.equal(unitEconomics(row({ feeAmount: Number.NaN })), null);
});
check("only live, fresh, in-stock Shopify items count as sellable and are ranked", () => {
  const summary = summarizeUnitEconomics([
    row({ variantId: "a", sellingPrice: 9000, expectedProfit: 4800 }),
    row({ variantId: "b", sellingPrice: 3000, expectedProfit: 1500 }),
    row({ variantId: "c", liveOnShopify: false }),
    row({ variantId: "d", offerFresh: false }),
    row({ variantId: "e", inventory: 0 }),
    row({ variantId: "f", expectedProfit: -1 }),
  ]);
  assert.deepEqual(summary.counts, { input: 6, scored: 5, unscored: 1, sellableOnShopify: 2 });
  assert.equal(summary.topByMaxCpa[0].variantId, "a");
  assert.equal(summary.lowestBreakEvenRoas[0].variantId, "a");
  assert.equal(summary.priceBands.find((band) => band.band === "7000-9999").count, 1);
});

const route = await readFile(new URL("../app/api/admin/commerce/unit-economics/route.ts", import.meta.url), "utf8");
check("the route is authenticated, read-only and returns no customer data", () => {
  assert.match(route, /requireAutomationAuth\(request\)/);
  assert.doesNotMatch(route, /\.(insert|update|upsert|delete)\(/);
  assert.doesNotMatch(route, /shipping_address|customer_name|email|phone/);
});
const workflow = await readFile(new URL("../.github/workflows/tracer-unit-economics-readonly.yml", import.meta.url), "utf8");
check("the workflow only issues GET requests", () => {
  assert.doesNotMatch(workflow, /-X (POST|PUT|PATCH|DELETE)|--data|-d '/);
});

console.log(`unit economics: ${cases} cases passed`);
