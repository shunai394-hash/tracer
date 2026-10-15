import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const discovery = fs.readFileSync(new URL("../lib/suppliers/discover-cj-supply.ts", import.meta.url), "utf8");
const supplyFirst = source.indexOf('const supplyFirstStep');
const marketplace = source.indexOf('runStep("bestsellers"');
assert.ok(supplyFirst >= 0, "supply-first discovery step must exist");
assert.ok(marketplace >= 0, "marketplace collection step must exist");
assert.ok(supplyFirst < marketplace, "supply-first stage marker must remain before slower marketplace collection");
assert.match(source, /dedicated_supply_first_cron_owns_live_cj_discovery/);
assert.doesNotMatch(source, /discoverAndCreateCjSupply\(/, "short patrol must not duplicate live CJ requests");
assert.match(source, /discoveryCron: "\/api\/cron\/supply-first"/);
assert.match(discovery, /reason: "supplier_quota_cooldown"/, "an open CJ quota circuit must report the actual blocker");
assert.match(discovery, /deadlineReached: false,[\s\S]*?skipped: true,[\s\S]*?retryable: true/, "quota cooldown must be reported as an intentional retryable skip, not a false deadline timeout");
assert.match(discovery, /retryAfter: quotaBlockedUntil/, "the caller must receive the exact quota-cooldown end time");
console.log("supply-first dedicated-cron ownership checks passed");
