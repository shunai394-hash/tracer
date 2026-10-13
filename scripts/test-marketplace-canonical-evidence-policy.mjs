import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");

// All marketplace-ranking sources are disabled. Tests must enforce that policy,
// not the retired source-index-specific behavior.
assert.ok(pipeline.includes('reason: "marketplace_ranking_sources_disabled_by_policy"'), "pipeline must explicitly skip marketplace ranking");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = false"), "marketplace ranking results must never feed the sales gate");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped or retryable stages must never feed the sales gate");
assert.ok(collector.includes("marketplaces: []"), "collector must return no marketplace results");
assert.ok(collector.includes("itemCount: 0"), "collector must report zero marketplace items");
for (const forbidden of [
  "amazon.co.jp",
  "ranking.rakuten.co.jp",
  "shopping.yahoo.co.jp",
  "retryBrightDataWhenCanonicalVariantsMissing",
  "hasAmazonVariantEvidence",
  "fetch(",
]) {
  assert.equal(collector.includes(forbidden), false, `disabled collector must not contain ${forbidden}`);
}
console.log("Marketplace canonical evidence policy: disabled-source invariants passed");
