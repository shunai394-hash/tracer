import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
const discovery = fs.readFileSync(new URL("../lib/suppliers/discover-cj-supply.ts", import.meta.url), "utf8");
const cronRoute = fs.readFileSync(new URL("../app/api/cron/supply-first/route.ts", import.meta.url), "utf8");
const supplyFirst = source.indexOf('const supplyFirstStep');
const firstEnrichment = source.indexOf('runStep("auxiliary_trends"');
assert.ok(supplyFirst >= 0, "supply-first discovery step must exist");
assert.ok(firstEnrichment >= 0, "supplier-native patrol enrichment stage must exist");
assert.ok(supplyFirst < firstEnrichment, "supply-first stage marker must remain before secondary intelligence enrichment");
assert.match(source, /dedicated_supply_first_cron_owns_live_cj_discovery/);
assert.doesNotMatch(source, /discoverAndCreateCjSupply\(/, "short patrol must not duplicate live CJ requests");
assert.match(source, /discoveryCron: "\/api\/cron\/supply-first"/);
assert.match(discovery, /reason: "supplier_quota_cooldown"/, "an open CJ quota circuit must report the actual blocker");
assert.match(discovery, /deadlineReached: false,[\s\S]*?skipped: true,[\s\S]*?retryable: true/, "quota cooldown must be reported as an intentional retryable skip, not a false deadline timeout");
assert.match(discovery, /retryAfter: quotaBlockedUntil/, "the caller must receive the exact quota-cooldown end time");
assert.match(discovery, /const resolvedSeededVariant = await resolveCJVariantProductIdentity\(candidate\.id, candidate\.variantId, productScopedVariant\)/, "seeded refresh must resolve the exact live CJ product/variant pair");
assert.match(discovery, /if \(productScopedVariant && productScopedVariant\.vid === variantId && scopedProductId\) \{/, "an exact variant returned by the live product-scoped endpoint must not be rejected by a redundant queryByVid lookup");
assert.match(discovery, /if \(!liveVariant \|\| liveVariant\.vid !== variantId \|\| !liveProductId\) return null/, "variant identity resolution must require the exact live variant ID and canonical supplier product ID");
assert.match(discovery, /const liveCost = Number\(seededVariant\.sellPrice\)/, "seeded refresh must use current exact-variant price instead of stale persisted cost");
assert.match(discovery, /const liveProductId = liveVariant\?\.productId\?\.trim\(\)[\s\S]*?supplierProductId: liveProductId/, "exact live variant lookup must resolve the canonical parent product even when the seeded catalog ID is stale");
assert.match(discovery, /if \(supplierProductId !== candidate\.id\) \{[\s\S]*?getCJProductDetail\(supplierProductId\)[\s\S]*?detail = \{ title: canonicalTitle, imageUrl: canonicalImageUrl/, "a corrected parent product ID must have its own live title/image re-fetched before use");
assert.match(discovery, /const preserveVerifiedOrderPath =[\s\S]*?seededCandidate\.apiAvailable[\s\S]*?seededCandidate\.orderable[\s\S]*?seededCandidate\.trackingAvailable[\s\S]*?seededCandidate\.supplierVariantId === candidate\.variantId/, "only the same previously verified supplier order path may retain orderability");
assert.match(discovery, /seededCandidate\.verificationError === ""[\s\S]*?no_unique_canonical_child_variant_match/, "only known recoverable verification errors may be cleared after fresh evidence");
assert.match(discovery, /verification_status: preserveVerifiedOrderPath \? "verified" : "unverified"/, "fresh stock/price checks must not invent orderability for a new supplier path");
assert.match(discovery, /next_verification_at: new Date\(Date\.now\(\) \+ 24 \* 60 \* 60 \* 1000\)\.toISOString\(\)/, "successfully processed supplier rows must advance the due queue instead of starving all later candidates");
assert.match(discovery, /seededVerificationLimit = Math\.min\(5, Math\.max\(0, limit\)\)/, "a bounded batch of existing due suppliers must be refreshed before new-catalog discovery");
assert.match(discovery, /catalogDiscoveryLimit = Math\.max\(0, limit - seededChecked\)/, "seeded refresh attempts must consume the same bounded run budget instead of multiplying provider calls");
assert.match(discovery, /catalogDiscovered < catalogDiscoveryLimit/, "new catalog discovery must use only the remaining per-run candidate budget");
assert.match(discovery, /let catalogAttempted = 0;[\s\S]*?if \(catalogAttempted >= catalogDiscoveryLimit[\s\S]*?catalogAttempted \+= 1;/, "rejected or unavailable new candidates must still consume the bounded attempt budget");

assert.match(discovery, /api_available: preserveVerifiedOrderPath[\s\S]*?orderable: preserveVerifiedOrderPath[\s\S]*?tracking_available: preserveVerifiedOrderPath/, "new candidates must not inherit an existing supplier order path");
assert.match(cronRoute, /job_name: "supply-first"/, "the dedicated supplier cron must write an auditable run record");
assert.match(cronRoute, /status: "running"/);
assert.match(cronRoute, /const runStatus = discoveryIncomplete \? "failed" : "succeeded"/, "incomplete discovery must not be reported as succeeded");
assert.match(cronRoute, /status: "failed"/);
assert.match(cronRoute, /quotaBlocked: supplyFirst\.quotaBlocked === true/, "quota cooldowns must be distinguishable from successful product discovery");
assert.match(cronRoute, /retryAfter: typeof supplyFirst\.retryAfter === "string"/, "the audit record must retain the next retry time without logging credentials");

console.log("supply-first dedicated-cron ownership checks passed");


// Market evidence must stay separate from supplier-native discovery and sales eligibility.
assert.match(source, /marketplace_sourcing_disabled_supplier_native_only/);
assert.doesNotMatch(source, /writeMarketCursor|persistMarketplaceBestsellers/);
