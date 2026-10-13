import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const cursorWrite = source.indexOf('const next = await writeMarketCursor(db, observation, "patrol-ai")');
const guard = source.indexOf("const emptyCollection = observation.itemCount === 0", cursorWrite);
const finalReturn = source.indexOf("return { ...observation, cursor, nextCursor: next };", guard);

assert.ok(cursorWrite >= 0, "market cursor must be persisted before collection/evidence retry decisions");
assert.ok(guard > cursorWrite, "empty-evidence guard must run after cursor advancement");
assert.ok(finalReturn > guard, "normal success return must follow the retry guard");
const guarded = source.slice(guard, finalReturn);
assert.ok(source.includes('reason: "marketplace_ranking_sources_disabled_by_policy"'), "pipeline must bypass marketplace ranking intake");
assert.ok(source.includes('runStep("supply_first"'), "supplier-first discovery must continue without marketplace ranking sources");
assert.ok(source.includes('runStep("supply_sales_test_select"'), "supplier candidates must still pass the sales-test gate");
assert.ok(collector.includes('["yahoo_shopping", "rakuten", "amazon.co.jp"].includes(selectedSource.marketplace)'), "all three marketplace ranking sources must be disabled");
assert.ok(collector.includes('reason: "marketplace_source_removed_by_policy"'), "disabled sources must be reported explicitly");
console.log("PASS: marketplace ranking sources disabled; supplier-first gated pipeline remains active");
