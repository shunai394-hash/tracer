import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

// Child-page retry used to belong to the retired Amazon sourcing pipeline.
// The safety contract now is that this collector cannot make network requests.
for (const forbidden of [
  "amazon.co.jp",
  "ranking.rakuten.co.jp",
  "shopping.yahoo.co.jp",
  "fetch(",
  "retryBrightDataWhenAmazonIdentifierMissing",
  "fetchBrightDataPage",
]) {
  assert.equal(collector.includes(forbidden), false, `disabled collector must not contain ${forbidden}`);
}
assert.ok(collector.includes("marketplaces: []"), "collector must return no marketplace results");
assert.ok(pipeline.includes("marketplace_ranking_sources_disabled_by_policy"), "pipeline must explicitly disable marketplace rankings");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = false"), "marketplace rankings must not feed sales tests");

console.log("PASS: retired child-page retry cannot re-enable marketplace network sourcing");
