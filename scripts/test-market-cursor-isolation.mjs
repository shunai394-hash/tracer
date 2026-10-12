import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cursor = await readFile(new URL("../lib/market/market-cursor.ts", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const sourcing = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");

assert.match(cursor, /"market-sourcing":\s*"market-sourcing"/, "market-sourcing keeps its own cursor namespace");
assert.match(cursor, /"patrol-ai":\s*"patrol-ai-market-cursor"/, "patrol-ai uses a separate cursor namespace");
assert.match(cursor, /function cursorJob\(actor: string\)/, "cursor namespace is selected from an explicit actor");
assert.match(pipeline, /readMarketCursor\(db,\s*"patrol-ai"\)/, "patrol-ai reads its own cursor");
assert.match(pipeline, /writeMarketCursor\(db, observation, "patrol-ai"\)/, "patrol-ai writes its own cursor");
assert.match(sourcing, /job_name:\s*"market-sourcing"/, "scheduled market sourcing retains its existing cursor source");
assert.doesNotMatch(cursor, /const JOB = "market-sourcing"/, "cursor reads must not hardcode one shared job");
console.log("PASS: patrol-ai and market-sourcing cursors are isolated");
