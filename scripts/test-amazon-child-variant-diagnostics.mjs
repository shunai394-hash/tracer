import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

// Amazon-specific child-variant diagnostics are obsolete after marketplace-ranking
// sourcing was disabled. Protect the new policy boundary instead of requiring
// collector internals that were intentionally removed.
for (const forbidden of [
  "amazon.co.jp",
  "ranking.rakuten.co.jp",
  "shopping.yahoo.co.jp",
  "fetch(",
  "fetchBrightDataPage",
  "parseAmazon",
]) {
  assert.equal(source.includes(forbidden), false, `disabled collector must not contain ${forbidden}`);
}
assert.ok(source.includes("marketplaces: []"), "compatibility collector must return no marketplace results");
assert.ok(source.includes("itemCount: 0"), "compatibility collector must report zero results");
assert.ok(pipeline.includes("marketplace_ranking_sources_disabled_by_policy"), "pipeline must explicitly skip marketplace ranking");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = false"), "marketplace rankings must not enter the sales gate");

console.log("PASS: retired marketplace diagnostics cannot re-enable marketplace sourcing");
