import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scoring = await readFile(new URL("../lib/intelligence/score-products.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

// Keep scoring bounded so the full-catalog N+1 query pattern cannot return.
assert.match(scoring, /const SCORE_BATCH_SIZE = 100/);
assert.match(scoring, /\.range\(offset, offset \+ SCORE_BATCH_SIZE - 1\)/);
assert.match(scoring, /\.from\("product_offers"\)[\s\S]*?\.in\("product_id", productIds\)/);
assert.match(scoring, /const UPDATE_CONCURRENCY = 10/);
assert.match(scoring, /product_offers_batch_limit_exceeded/);

// The score stage must have enough budget for one bounded batch, while still
// leaving the rest of the pipeline's deadline intact.
assert.match(pipeline, /runStep\("score", \(\) => scoreProductIntelligence\(\), \{ downstream: true, budgetMs: 20_000 \}\)/);
assert.match(pipeline, /runStep\("shopping_demand_sync", \(\) => syncShoppingDemandObservations\(\), \{ budgetMs: 15_000 \}\)/);
assert.match(pipeline, /runStep\("demand", \(\) => inspectDemandObservations\(\), \{ budgetMs: 5_000 \}\)/);
assert.match(pipeline, /runStep\("demand_analyze", \(\) => persistDemandIntelligence\(\), \{ budgetMs: 25_000 \}\)/);
assert.match(pipeline, /runStep\("ordering", \(\) => persistReorderRecommendations\(\), \{ downstream: true, budgetMs: 15_000 \}\)/);
console.log("Bounded scoring, demand-stage budgets, and reorder-stage budget: 10 assertions passed");
