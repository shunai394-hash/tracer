import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");

// Marketplace-ranking collection and its evidence-retry path were retired together.
// This test now protects the policy boundary instead of requiring the deleted Amazon proxy path.
assert.ok(source.includes("marketplace_ranking_sources_disabled_by_policy"), "pipeline must explicitly skip disabled marketplace ranking sources");
assert.ok(source.includes("const bestsellerCanFeedSalesGate = false"), "marketplace ranking results must not enter the sales gate");
assert.equal(source.includes("writeMarketCursor(db, observation, \"patrol-ai\")"), false, "disabled ranking collection must not persist/advance its cursor");
assert.equal(collector.includes("amazon.co.jp"), false, "Amazon source URL must be absent");
assert.equal(collector.includes("ranking.rakuten.co.jp"), false, "Rakuten source URL must be absent");
assert.equal(collector.includes("shopping.yahoo.co.jp"), false, "Yahoo! Shopping source URL must be absent");
assert.equal(collector.includes("fetch("), false, "disabled collector must not perform network requests");
assert.ok(collector.includes("marketplaces: []"), "compatibility collector must return no marketplace items");
assert.ok(collector.includes("itemCount: 0"), "compatibility collector must report zero marketplace items");

console.log("PASS: disabled marketplace ranking sources cannot fetch, advance ranking cursors, or feed the sales gate");
