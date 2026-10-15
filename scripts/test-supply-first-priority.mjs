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
assert.match(discovery, /const seededVariant = seededVariants\.find\(\(item\) => item\.vid === candidate\.variantId\)/, "seeded refresh must verify the exact live CJ product/variant pair");
assert.match(discovery, /const liveCost = Number\(seededVariant\.sellPrice\)/, "seeded refresh must use current exact-variant price instead of stale persisted cost");
assert.match(discovery, /const preserveVerifiedOrderPath =[\s\S]*?seededCandidate\.apiAvailable[\s\S]*?seededCandidate\.orderable[\s\S]*?seededCandidate\.trackingAvailable[\s\S]*?seededCandidate\.supplierVariantId === candidate\.variantId/, "only the same previously verified supplier order path may retain orderability");
assert.match(discovery, /seededCandidate\.verificationError === ""[\s\S]*?no_unique_canonical_child_variant_match/, "only known recoverable verification errors may be cleared after fresh evidence");
assert.match(discovery, /verification_status: preserveVerifiedOrderPath \? "verified" : "unverified"/, "fresh stock/price checks must not invent orderability for a new supplier path");
assert.match(discovery, /next_verification_at: new Date\(Date\.now\(\) \+ 24 \* 60 \* 60 \* 1000\)\.toISOString\(\)/, "successfully processed supplier rows must advance the due queue instead of starving all later candidates");
assert.match(discovery, /seededVerificationLimit = Math\.min\(5, Math\.max\(0, limit\)\)/, "a bounded batch of existing due suppliers must be refreshed before new-catalog discovery");
assert.match(discovery, /catalogDiscoveryLimit = Math\.max\(0, limit - seededChecked\)/, "seeded refresh attempts must consume the same bounded run budget instead of multiplying provider calls");
assert.match(discovery, /catalogDiscovered < catalogDiscoveryLimit/, "new catalog discovery must use only the remaining per-run candidate budget");

assert.match(discovery, /api_available: preserveVerifiedOrderPath[\s\S]*?orderable: preserveVerifiedOrderPath[\s\S]*?tracking_available: preserveVerifiedOrderPath/, "new candidates must not inherit an existing supplier order path");

console.log("supply-first dedicated-cron ownership checks passed");
