import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const adapter = await readFile(new URL("../lib/procurement/tracer-internal-adapter.ts", import.meta.url), "utf8");
const capabilityBlock = adapter.match(/capabilities:\s*\{([\s\S]*?)\n\s*\},/);
assert.ok(capabilityBlock, "internal supplier capability block must exist");
assert.match(capabilityBlock[1], /orderPreflight:\s*false/, "internal fulfillment must not claim supplier order preflight");
assert.match(capabilityBlock[1], /orderCreation:\s*false/, "internal fulfillment record must not count as a supplier order");
assert.match(capabilityBlock[1], /payment:\s*false/, "internal reservation must not claim supplier-side payment");
assert.match(capabilityBlock[1], /liveOrdering:\s*false/, "internal inventory reservation must not claim live supplier ordering");

const eligibility = await readFile(new URL("../lib/procurement/auto-eligibility.ts", import.meta.url), "utf8");
assert.match(eligibility, /AUTO_PROCUREMENT_REQUIRED_CAPABILITIES/);
assert.match(eligibility, /capabilities\[capability\] !== true/);

console.log("Internal supplier capability fail-closed checks: 6 passed");
