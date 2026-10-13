import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");

assert.ok(
  source.includes('reason: "marketplace_ranking_sources_disabled_by_policy"'),
  "pipeline must not depend on marketplace ranking collection",
);
assert.ok(
  collector.includes('["yahoo_shopping", "rakuten", "amazon.co.jp"].includes(selectedSource.marketplace)'),
  "Yahoo, Rakuten, and Amazon ranking sources must all be disabled",
);
assert.ok(
  collector.includes('reason: "marketplace_source_removed_by_policy"'),
  "disabled marketplace sources must be explicitly marked as skipped",
);
assert.ok(source.includes('runStep("supply_first"'), "direct supplier discovery must continue");
assert.ok(source.includes('"supply_sales_test_select"'), "supplier products must pass the sales-test gate");
assert.ok(source.includes('runStep("sales_test_select"'), "legacy market sales path must remain present but receive no ranking candidates");
assert.ok(source.includes("canFeedSalesGate(bestsellerStep)"), "market evidence cannot bypass the strict sales gate");
console.log("PASS: marketplace ranking intake disabled; direct supplier discovery and sales gates retained");
