import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/api/cron/supply-first/route.ts", import.meta.url), "utf8");
const quotaCheck = source.indexOf('.eq("job_name", "cj-api-quota-circuit")');
const runInsert = source.indexOf('.from("cron_runs").insert({');
const discoveryCall = source.indexOf("discoverAndCreateCjSupply(");
assert.ok(quotaCheck >= 0, "supply-first must read the persisted CJ quota circuit");
assert.ok(runInsert > quotaCheck, "quota circuit must be checked before creating a run record");
assert.ok(discoveryCall > quotaCheck, "quota circuit must be checked before supplier discovery");
const blockedBranch = source.slice(quotaCheck, runInsert);
assert.match(blockedBranch, /isCJQuotaCircuitActive\(quotaMetadata\)/, "only explicit quota exhaustion should defer the run; legacy ambiguous circuits must be ignored");
assert.match(blockedBranch, /reason: "supplier_quota_cooldown"/, "cooldown response must expose the reason");
assert.match(blockedBranch, /discoveryInvoked: false/, "cooldown response must confirm discovery was not invoked");
assert.match(blockedBranch, /runRecordCreated: false/, "cooldown response must confirm no noisy run record was created");
assert.match(blockedBranch, /retryAfter: blockedUntil/, "cooldown response must expose the retry time");
console.log("Supply-first CJ quota cooldown: 7 invariants passed");
