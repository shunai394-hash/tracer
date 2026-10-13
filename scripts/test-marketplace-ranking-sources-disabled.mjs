import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const capabilityMap = await readFile(new URL("../components/capability-map.tsx", import.meta.url), "utf8");

test("Amazon, Rakuten, and Yahoo Shopping ranking collection is disabled before any network fetch", () => {
  assert.match(collector, /export const MARKETPLACE_SOURCING_ENABLED = false/);
  assert.match(collector, /if \(!MARKETPLACE_SOURCING_ENABLED\)\s*\{\s*return \{ fetchedAt, marketplaces, itemCount: 0, sourceIndex: requestedSourceIndex \};\s*\}/);
  const guardIndex = collector.indexOf("if (!MARKETPLACE_SOURCING_ENABLED)");
  const fetchIndex = collector.indexOf("const collectedSources = await Promise.all");
  assert.ok(guardIndex >= 0 && fetchIndex > guardIndex, "disabled guard must run before any source fetch");
});

test("disabled ranking feeds do not defer the supplier-led intelligence pipeline", () => {
  assert.match(pipeline, /reason: "marketplace_ranking_sources_disabled_by_policy"/);
  assert.match(pipeline, /const bestsellerCanFeedSalesGate = false/);
  assert.doesNotMatch(pipeline, /persistMarketplaceBestsellers\(/);
});

test("the product-facing system map describes supplier-led discovery, not marketplace rankings", () => {
  assert.match(capabilityMap, /仕入先の実在商品・在庫・価格・バリエーション証拠/);
});
