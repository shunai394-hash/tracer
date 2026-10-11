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
assert.match(identityRoute, /reverifyCjSupplyIdentities\(\{[\s\S]*?limit: 25,[\s\S]*?startedAt \+ 150_000/);
const discovery = await readFile(new URL("../lib/suppliers/discover-cj-supply.ts", import.meta.url), "utf8");
assert.equal((discovery.match(/gtin: normalizeIdentifier\("gtin", variantBarcode\)/g) ?? []).length, 2);
assert.match(discovery, /function priorityWomenSupplyCategory/);
assert.match(discovery, /priorityWomenSupplyCategory\(row\.title, row\.metadata\) < 99/);
const reverify = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
assert.match(reverify, /const MAX_CANDIDATE_SCAN = 500/);
assert.match(reverify, /\.limit\(MAX_CANDIDATE_SCAN\)/);
assert.match(reverify, /buildCandidateQuery\(\)\.gt\("id", priorCursor\)/);
assert.match(reverify, /nextCursor: scanCursor/);
console.log("Bounded demand identity stamping and CJ reverify: 15 assertions passed");
