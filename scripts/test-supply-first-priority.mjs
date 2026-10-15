import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const discovery = fs.readFileSync(new URL("../lib/suppliers/discover-cj-supply.ts", import.meta.url), "utf8");
const supplyFirst = source.indexOf('runStep("supply_first"');
const marketplace = source.indexOf('runStep("bestsellers"');
assert.ok(supplyFirst >= 0, "supply-first discovery step must exist");
assert.ok(marketplace >= 0, "marketplace collection step must exist");
assert.ok(supplyFirst < marketplace, "supply-first must run before slower marketplace collection");
assert.match(source, /discoverAndCreateCjSupply\(3,\s*\{\s*deadlineAt: Math\.min\(pipelineDeadlineAt - 5_000, Date\.now\(\) \+ 18_000\)/);
assert.match(source, /supplyFirstResult\?\.deadlineReached === true/);
assert.match(discovery, /reason: "supplier_quota_cooldown"/, "an open CJ quota circuit must report the actual blocker");
assert.match(discovery, /deadlineReached: false,[\s\S]*?skipped: true,[\s\S]*?retryable: true/, "quota cooldown must be reported as an intentional retryable skip, not a false deadline timeout");
assert.match(discovery, /retryAfter: quotaBlockedUntil/, "the caller must receive the exact quota-cooldown end time");
assert.match(discovery, /const seededVariant = seededVariants\.find\(\(item\) => item\.vid === candidate\.variantId\)/, "seeded refresh must verify the exact live CJ product/variant pair");
assert.match(discovery, /const liveCost = Number\(seededVariant\.sellPrice\)/, "seeded refresh must use current exact-variant price instead of stale persisted cost");
assert.match(discovery, /const preserveVerifiedOrderPath =[\s\S]*?seededCandidate\.apiAvailable[\s\S]*?seededCandidate\.orderable[\s\S]*?seededCandidate\.trackingAvailable[\s\S]*?seededCandidate\.supplierVariantId === candidate\.variantId/, "only the same previously verified supplier order path may retain orderability");
assert.match(discovery, /verification_status: preserveVerifiedOrderPath \? "verified" : "unverified"/, "fresh stock/price checks must not invent orderability for a new supplier path");
assert.match(discovery, /next_verification_at: new Date\(Date\.now\(\) \+ 24 \* 60 \* 60 \* 1000\)\.toISOString\(\)/, "successfully processed supplier rows must advance the due queue instead of starving all later candidates");
assert.match(discovery, /configured,api_available,orderable,tracking_available,ship_to,verification_error,last_verified_at/, "the seed queue must read prior order-path evidence before deciding what to preserve");
assert.match(discovery, /seededCandidate\.verificationError === ""[\s\S]*?no_unique_canonical_child_variant_match/, "only known recoverable verification errors may be cleared after fresh evidence");
assert.match(discovery, /api_available: preserveVerifiedOrderPath[\s\S]*?orderable: preserveVerifiedOrderPath[\s\S]*?tracking_available: preserveVerifiedOrderPath/, "new supplier candidates must not inherit orderability without prior verified evidence");


console.log("supply-first discovery priority checks passed");
