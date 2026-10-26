import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/stamp-cj-identities.ts", import.meta.url), "utf8");

assert.match(source, /const IDENTITY_BATCH_SIZE = 100/);
assert.match(source, /\.range\(offset, offset \+ batchSize - 1\)/);
assert.match(source, /Math\.floor\(Date\.now\(\) \/ \(15 \* 60_000\)\) % pages/);
assert.match(source, /const IDENTITY_UPDATE_CONCURRENCY = 10/);
assert.match(source, /Promise\.all\(batch\.map\(\(item\) =>[\s\S]*?\.update\(item\.payload\)\.eq\("id", item\.id\)/);
assert.match(source, /payload\.product_id = null/);
assert.match(source, /candidateIds\.length > 0/);
assert.match(source, /if \(!candidate \|\| !title\)/);
assert.match(source, /missingDemandCandidate: !candidate/);
assert.match(source, /identity_status: "identity_unconfirmed"/);
const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
assert.doesNotMatch(pipeline, /reverifyCjSupplyIdentities\(/);
const identityRoute = await readFile(new URL("../app/api/cron/cj-identity-reverify/route.ts", import.meta.url), "utf8");
assert.match(identityRoute, /Math\.min\(25, Math\.floor\(requestedLimit\)\)/,
  "forced CJ freshness checks remain capped at 25 rows");
assert.match(identityRoute, /const force = url\.searchParams\.get\("force"\) === "1"/);
assert.match(identityRoute, /reverifyCjSupplyIdentities\(\{[\s\S]*?limit,[\s\S]*?force,[\s\S]*?startedAt \+ 150_000/);
const discovery = await readFile(new URL("../lib/suppliers/discover-cj-supply.ts", import.meta.url), "utf8");
assert.equal((discovery.match(/gtin: normalizeIdentifier\("gtin", variantBarcode\)/g) ?? []).length, 2);
assert.match(discovery, /function priorityWomenSupplyCategory/);
assert.match(discovery, /Include every due supplier category/);
assert.match(discovery, /priorityWomenSupplyCategory\(a\.title, a\.metadata\) - priorityWomenSupplyCategory\(b\.title, b\.metadata\)/,
  "women-focused categories remain prioritized without excluding other categories");
const reverify = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
assert.match(reverify, /const MAX_CANDIDATE_SCAN = 500/);
assert.match(reverify, /\.limit\(MAX_CANDIDATE_SCAN\)/);
assert.match(reverify, /buildCandidateQuery\(\)\.gt\("id", priorCursor\)/);
assert.match(reverify, /const boundedRows = allRows\s*\.slice\(\)\s*\.sort\(\(a, b\) => String\(a\.id\)\.localeCompare\(String\(b\.id\)\)\)\s*\.slice\(0, limit\)/, "cursor-safe bounded window is selected in ascending ID order");
assert.match(reverify, /result\.nextCursor = String\(boundedRows\[boundedRows\.length - 1\]\.id\)/, "reverify cursor advances to the end of the complete bounded ID window");
assert.match(reverify, /if \(quotaExhausted \|\| circuitBlocked \|\| targetSupplierListingIds\.length > 0\) \{\s*result\.nextCursor = priorCursor;/, "quota blocks and targeted runs preserve the prior cursor");
assert.match(reverify, /sort\(\(a, b\) => String\(a\.id\)\.localeCompare\(String\(b\.id\)\)\)/, "cursor batches must be ordered to avoid skipping unprocessed supplier rows");
const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const activeSourceStart = collector.indexOf("export const MARKETPLACE_SOURCES");
const activeSourceEnd = collector.indexOf("];", activeSourceStart);
const activeSourceBlock = collector.slice(activeSourceStart, activeSourceEnd);
assert.match(activeSourceBlock, /yahoo_shopping_ranking/);
assert.doesNotMatch(activeSourceBlock, /amazon_bestsellers|rakuten_ranking/,
  "Amazon/Rakuten are excluded from active demand fetches; Yahoo is demand research only");
assert.match(collector, /skipped: items\.length === 0/);
assert.match(collector, /ranking_html_returned_zero_items/);
console.log("Bounded demand identity stamping and CJ reverify: 18 assertions passed");
