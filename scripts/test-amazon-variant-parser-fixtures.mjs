import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

// Historical Amazon HTML parser fixtures are no longer an active sourcing contract.
// Keep the prebuild check focused on preventing marketplace feeds from returning.
for (const forbidden of [
  "amazon.co.jp",
  "ranking.rakuten.co.jp",
  "shopping.yahoo.co.jp",
  "fetch(",
  "fetchBrightDataPage",
  "parseAmazon",
]) {
  assert.equal(collector.includes(forbidden), false, `collector must not contain ${forbidden}`);
}
assert.ok(collector.includes("marketplaces: []"), "collector must return no marketplace results");
assert.ok(pipeline.includes("marketplace_ranking_sources_disabled_by_policy"), "pipeline must keep marketplace ranking disabled");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = false"), "marketplace rankings must not feed sales tests");

console.log("PASS: retired marketplace parser fixtures replaced with disabled-source policy assertions");
