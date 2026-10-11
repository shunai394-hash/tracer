import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Source-contract tests only: no live database writes or external provider calls.
const reorder = await readFile(new URL("../lib/ordering/persist-reorder.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

assert.match(reorder, /const REORDER_BATCH_SIZE = 10/);
assert.match(reorder, /\.range\(offset, offset \+ REORDER_BATCH_SIZE - 1\)/);
assert.match(reorder, /\.in\("product_id", productIds\)/);
assert.match(reorder, /\.eq\("product_id", productId\)[\s\S]*?\.limit\(1\)/);
assert.match(reorder, /\.in\("opportunity_id", opportunityIds\)[\s\S]*?\.gte\("created_at", recentSince\)/);
assert.match(reorder, /const REORDER_WRITE_CONCURRENCY = 3/);
assert.match(reorder, /spentToday: null/, "unknown daily spend must not be fabricated as zero");
assert.match(reorder, /spentMonth: null/, "unknown monthly spend must not be fabricated as zero");
assert.match(reorder, /spentProduct: null/, "unknown product spend must not be fabricated as zero");
assert.match(reorder, /spentCategory: null/, "unknown category spend must not be fabricated as zero");
assert.match(reorder, /pendingRows = rows\.filter\(\(row\) => !recentlyRecommended\.has\(String\(row\.id\)\)\)/);
assert.match(pipeline, /runStep\("ordering", \(\) => persistReorderRecommendations\(\), \{ downstream: true, budgetMs: 15_000 \}\)/);

console.log("Bounded reorder recommendations: 12 assertions passed");
