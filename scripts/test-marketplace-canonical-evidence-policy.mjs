import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const gate = await readFile(new URL("../lib/intelligence/bestseller-sales-gate.ts", import.meta.url), "utf8");

assert.ok(pipeline.includes("marketplace_sourcing_disabled_supplier_native_only"), "marketplace ranking collection must be disabled");
assert.ok(!pipeline.includes("persistMarketplaceBestsellers"), "patrol must not collect marketplace-derived candidates");
assert.ok(pipeline.includes("name: \"sales_test_select\"") && pipeline.includes("marketplace_sourcing_disabled_supplier_native_only"), "marketplace sales-test selection must be explicitly skipped");
assert.ok(gate.includes("stage.ok && stage.skipped !== true && stage.retryable !== true"), "skipped source rows must never feed the sales gate");
assert.ok(pipeline.includes('reason: "marketplace_rankings_not_used_for_supplier_procurement"'), "ranking observations must not be treated as supplier procurement inputs");
assert.ok(pipeline.includes('discoveryCron: "/api/cron/commerce-cj-import"'), "supplier procurement must be routed to the canonical commerce CJ importer");
assert.doesNotMatch(pipeline, /investigateDropshipForBestsellers/, "legacy ranking-driven supplier investigation must not run in the intelligence pipeline");
console.log("Marketplace canonical evidence policy: 8 assertions passed");
