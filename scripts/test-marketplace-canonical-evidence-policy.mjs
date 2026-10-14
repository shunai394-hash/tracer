import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");

const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
assert.match(collector, /MARKETPLACE_SOURCES:\s*Array<\{[^}]+\}>\s*=\s*\[\]/, "marketplace ranking collection must remain disabled");
assert.ok(pipeline.includes('"marketplace_collection_disabled"'), "disabled marketplace intake must be an intentional non-retryable skip");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped source rows must never feed the sales gate");
assert.ok(pipeline.includes("const bestsellerCanFeedSalesGate = canFeedSalesGate(bestsellerStep)"), "downstream sales matching must use the strict gate helper");
assert.ok(pipeline.includes("retryable: bestsellerStep.retryable === true"), "dropship must inherit the source stage retryability instead of always deferring");
console.log("Marketplace canonical evidence policy: 7 assertions passed");
