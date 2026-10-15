import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const supplyFirst = source.indexOf('runStep("supply_first"');
const marketplace = source.indexOf('runStep("bestsellers"');
assert.ok(supplyFirst >= 0, "supply-first discovery step must exist");
assert.ok(marketplace >= 0, "marketplace collection step must exist");
assert.ok(supplyFirst < marketplace, "supply-first must run before slower marketplace collection");
assert.match(source, /dedicated_supply_first_cron_owns_live_cj_discovery/);
assert.doesNotMatch(source, /discoverAndCreateCjSupply\(/, "short patrol must not duplicate live CJ requests");
assert.match(source, /discoveryCron: "\/api\/cron\/supply-first"/);
console.log("supply-first discovery priority checks passed");
