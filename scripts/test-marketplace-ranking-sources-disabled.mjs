import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const capabilityMap = await readFile(new URL("../components/capability-map.tsx", import.meta.url), "utf8");
const supplierInvestigation = await readFile(new URL("../lib/suppliers/investigate-dropship.ts", import.meta.url), "utf8");

test("marketplace ranking collector contains no source URLs or fetch logic", () => {
  assert.doesNotMatch(collector, /amazon\.co\.jp|ranking\.rakuten\.co\.jp|shopping\.yahoo\.co\.jp/i);
  assert.doesNotMatch(collector, /fetch\(|fetchBrightDataPage|parseAmazon|parseRakuten|parseYahoo/);
  assert.match(collector, /marketplaces: \[\]/);
  assert.match(collector, /itemCount: 0/);
});

test("ranking feeds cannot defer or feed the supplier-led intelligence pipeline", () => {
  assert.match(pipeline, /reason: "marketplace_ranking_sources_disabled_by_policy"/);
  assert.match(pipeline, /const bestsellerCanFeedSalesGate = false/);
  assert.doesNotMatch(pipeline, /persistMarketplaceBestsellers\(/);
  assert.doesNotMatch(pipeline, /runStep\("bestsellers"/);
});

test("supplier investigation does not fetch Amazon product pages to enrich old marketplace rows", () => {
  assert.doesNotMatch(supplierInvestigation, /amazon\\.co\\.jp|fetchBrightDataPage|parseAmazonProductDetail|enrichAsinOnlyRows/);
});

test("the product-facing system map describes supplier-led discovery, not marketplace rankings", () => {
  assert.match(capabilityMap, /仕入先の実在商品・在庫・価格・バリエーション証拠/);
});
