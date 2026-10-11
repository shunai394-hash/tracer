import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("lib/intelligence/run-intelligence-pipeline.ts", "utf8");
assert.match(source, /const bestsellerCanFeedSalesGate\s*=\s*bestsellerStep\.ok\s*&&\s*!bestsellerStep\.skipped\s*&&\s*bestsellerStep\.retryable !== true/);
const bestsellerBlock = source.match(/const bestsellerIds\s*=([\s\S]*?)\n\s*const supplierCandidateIds/);
assert.ok(bestsellerBlock, "bestseller candidate extraction must exist");
assert.match(bestsellerBlock[1], /bestsellerCanFeedSalesGate/);
const supplierBlock = source.match(/const supplierCandidateIds\s*=([\s\S]*?)\n\s*steps\.push\(await runStep\("auxiliary_trends"/);
assert.ok(supplierBlock, "supplier candidate extraction must exist");
assert.match(supplierBlock[1], /bestsellerCanFeedSalesGate/);
console.log("Deferred/retryable bestseller candidates are blocked from downstream sales and supplier gates.");
