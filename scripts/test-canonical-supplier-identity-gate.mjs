import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [helper, shopify, base, store, route, vercel, persist, demandCJ, demandSupplier, unpublishWorkflow, patrolWorkflow, patrolRoute, discoverCJ, directGate, salesPublicationRoute, e2eFunnel, intelligencePipeline, baseRepair, supplySelector] = await Promise.all([
  readFile(new URL("../lib/catalog/canonical-supplier-identity.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/unpublish-unlinked/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  readFile(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/intelligence/persist-demand-cj-products.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/intelligence/persist-demand-supplier-products.ts", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/tracer-unpublish-unlinked.yml", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/tracer-production-patrol-15m.yml", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/suppliers/discover-cj-supply.ts", import.meta.url), "utf8"),
  readFile(new URL("./direct-900-gate.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/sales-test-publication/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/intelligence/e2e-funnel/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/channels/base/identity-repair/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8"),
]);
assert.match(helper, /identity_status === "linked"/);
assert.match(helper, /verificationError === "CJdropshipping is not configured"/, "only the stale CJ configuration error may be ignored when the same row is currently configured and API-available");
assert.match(helper, /row.configured === true && row.api_available === true/);
assert.match(persist, /verification_error: marketplaceIdentity \|\| nativeEvidenceFresh \? null : \(priorVerificationError \|\| "no_unique_canonical_child_variant_match"\)/, "only fresh, fully verified native supply evidence may clear the old configuration error");
assert.match(discoverCJ, /identity_status: "supply_discovered", identity_confidence: 0/, "supply discovery without canonical identity must not claim perfect identity confidence");
assert.match(discoverCJ, /title: detail\.title, product_id: null/, "CJ supply discovery must not provisionally attach a canonical product ID before identity is resolved");
assert.match(discoverCJ, /api_available: preserveVerifiedOrderPath, verification_status: preserveVerifiedOrderPath \? "verified" : "unverified"/, "seeded refresh may preserve the existing verified order path only behind its strict evidence predicate");
assert.match(discoverCJ, /api_available: false,[\s\S]*?verification_status: "unverified"/, "new CJ supply must remain unverified until the order path is proven");
assert.match(discoverCJ, /orderable: false,[\s\S]*?tracking_available: false/, "new CJ supply must remain blocked from ordering even when price and stock observations exist");
assert.doesNotMatch(discoverCJ, /markVerification\(db, String\(supplierInsert\.data\.id\), \{ status: "verified"/, "discovery must not overwrite the unresolved identity gate with a verified status");

const supplierUpserts = [...discoverCJ.matchAll(/const supplierInsert = await upsertSupplierListing/g)].map((match) => {
  const end = discoverCJ.indexOf("if (supplierInsert.error)", match.index);
  assert.notEqual(end, -1, "each CJ supplier upsert must check persistence errors");
  return discoverCJ.slice(match.index, end);
});
assert.equal(supplierUpserts.length, 2, "both seeded and fresh CJ discovery paths must be guarded");
for (const upsert of supplierUpserts) {
  assert.match(upsert, /product_id: null/, "unresolved CJ supply must not attach a provisional canonical product");
  assert.match(upsert, /identity_status: "supply_discovered"/);
  assert.match(upsert, /identity_confidence: 0/, "unresolved CJ supply must have zero identity confidence");
  assert.doesNotMatch(upsert, /identity_confidence: 1|api_available: true|orderable: true|tracking_available: cjTrackingAvailable/, "discovery must not claim identity or order-path verification");
}
assert.match(supplierUpserts[0], /api_available: preserveVerifiedOrderPath[\s\S]*?orderable: preserveVerifiedOrderPath[\s\S]*?tracking_available: preserveVerifiedOrderPath/, "seeded refresh may retain orderability only for the exact previously verified product+variant path");
assert.match(supplierUpserts[1], /api_available: false,[\s\S]*?orderable: false,[\s\S]*?tracking_available: false/, "newly discovered CJ candidates must stay non-orderable");

assert.match(directGate, /\.eq\("identity_status", "linked"\)/, "direct sales-test gate must require canonical supplier identity");
assert.doesNotMatch(directGate, /identity_status\.eq\.supply_discovered/, "supply discovery alone must never enter direct sales-test selection");
assert.match(salesPublicationRoute, /\.eq\("identity_status", "linked"\)/, "sales-test publication prefilter must require linked supplier identity");
assert.match(salesPublicationRoute, /TRACER_CJ_NATIVE_SUPPLY_PUBLICATION_ENABLED !== "false"/, "verified native CJ supply must be publishable by default; only an explicit false setting may disable it");
assert.match(supplySelector, /const pool = verifiedCandidates;/, "sales-test selector must fail closed when no supplier offer passes all verification checks");
assert.doesNotMatch(supplySelector, /verifiedCandidates\.length > 0 \? verifiedCandidates : candidates/, "unverified supplier candidates must never be used as a fallback publication pool");
assert.doesNotMatch(salesPublicationRoute, /identity_status\.eq\.supply_discovered/, "sales-test publication must not prefilter unresolved supply as verified");
assert.match(e2eFunnel, /eq\("identity_status", "linked"\).*eq\("verification_status", "verified"\).*eq\("orderable", true\)/, "readiness funnel must not count unresolved supply as verified and orderable");
assert.match(intelligencePipeline, /\.eq\("verification_status", "verified"\)[\s\S]*?\.eq\("orderable", true\)/, "supply selection must still require verified, orderable supplier evidence");
assert.match(intelligencePipeline, /allowNativeCjIdentity:\s*true/, "standalone CJ supply must use the selector’s explicit native-supplier gate rather than pretending marketplace identity is linked");
assert.match(persist, /last_verified_at: marketplaceIdentity \? now : existingListing\.data\?\.last_verified_at \?\? null/, "unmatched identity must preserve the existing verification timestamp rather than making stale data look fresh");
assert.match(persist, /bestseller_id: marketplaceIdentity\?\.bestsellerId \?\? null/, "unmatched or ambiguous CJ identity must clear any stale canonical parent link");
assert.match(persist, /identity_status: marketplaceIdentity \? "linked" : "supply_discovered"/, "CJ discovery alone must not promote supplier identity to linked");
assert.doesNotMatch(persist, /orderable: false, tracking_available: false, api_available: false/, "identity recheck must not erase existing supplier order-path evidence");
assert.match(persist, /catalog_stage: "candidate"/, "unmatched supplier supply must be retained as a catalog candidate");
assert.ok(persist.includes('const nativeIdentityKey = `cj:${args.supplierProductId}:${args.supplierVariantId}`;'), "native candidate linkage must be grounded in the exact CJ product+variant identity key");
assert.doesNotMatch(persist, /\[existingProductId, discoveredProductId\]\.find/, "native candidate persistence must not trust an arbitrary caller-supplied UUID");
assert.match(persist, /purchasable: nativeEvidenceFresh/, "unmatched supply becomes purchasable only when fresh native supplier evidence passes");
assert.match(persist, /if \(!marketplaceIdentity\) return \{ offerId: null, intelligenceId: candidateIntelligenceId, identity: null \}/, "unmatched CJ identity must retain candidate intelligence without creating a marketplace offer");
assert.ok(persist.indexOf("if (!marketplaceIdentity)") < persist.indexOf("const offerPayload = {"), "no-match exit must happen before any product_offers write");
assert.match(persist, /offerId: string \| null; intelligenceId: string \| null/, "supply-only discovery must explicitly return absent canonical record IDs");
assert.doesNotMatch(demandCJ, /assessCanonicalIdentity|CANONICAL_LINK_THRESHOLD/, "CJ demand relevance must not link to a different existing canonical product");
assert.ok(demandCJ.includes("const identityKey = `cj::${sourceProductId}`;"), "CJ offers must use an exact stable source product key");
assert.ok(demandCJ.includes('.eq("identity_key", identityKey)'), "CJ canonical products may only be reused by exact source identity key");
assert.match(demandCJ, /Missing stable CJ product ID; canonical offer persistence blocked/);
assert.doesNotMatch(demandSupplier, /assessCanonicalIdentity|CANONICAL_LINK_THRESHOLD/, "supplier demand relevance must not be used as canonical identity proof");
assert.ok(demandSupplier.includes("const identityKey = `${sourceSupplierName}::${sourceProductId}`;"), "supplier offers must use an exact stable source identity key");
assert.ok(demandSupplier.includes('.eq("identity_key", identityKey)'), "supplier canonical products may only be reused by exact source identity key");
assert.match(demandSupplier, /Missing stable supplier name or product ID; canonical offer persistence blocked/);
assert.match(helper, /offset \+= 100/, "identity lookups must batch large supplier ID sets");
assert.doesNotMatch(shopify, /hasPublishableSupplierIdentity/, "supplier verification state must not gate storefront publication");
assert.doesNotMatch(shopify, /supplier_not_cj/, "profitable linked products from any supplier may be listed");
assert.match(shopify, /supplier_variant_missing/, "exact supplier product and variant IDs remain required");
assert.match(shopify, /inventory_not_positive/, "storefront inventory must be positive");
assert.match(shopify, /profit_not_positive/, "catalog publication requires positive contribution profit");
assert.match(base, /identityUnlinkedIds/);
assert.match(base, /supplier_product_id.not.is.null,supplier_variant_id.not.is.null/, "BASE retries linked catalog rows regardless of old hidden error markers");
assert.doesNotMatch(base, /if \(listing\.tracking_available !== true\)/, "tracking availability is not a publication gate");
assert.doesNotMatch(base, /listing\.orderable !== true/, "order-time supplier readiness is not a publication gate");
assert.match(base, /profit_not_positive/, "BASE publication requires positive contribution profit");
assert.match(base, /query\.order\("created_at", \{ ascending: false \}\)/,
  "BASE batches must prioritize new gate-passed listings instead of starving them behind old hidden rows");
assert.match(base, /base_last_error: isIdentityUnlinked \? "supplier_identity_unlinked_hidden" : "tracer_unpublished_hidden"/);
assert.match(store, /supplierListingId && supplierStatuses\.has/);
assert.match(store, /supplier_identity_unlinked/);
assert.match(route, /requireAutomationAuth/);
assert.match(route, /TRACER UNLINKED RECONCILIATION/, "production cleanup progress must be observable with count-only telemetry");
assert.match(route, /published: false/);
assert.match(route, /base_unpublish_failed/);
assert.match(route, /shopify_unpublish_failed/);
assert.match(base, /invalid_request.*break/s, "BASE auth failures must stop the current hide batch");
assert.match(base, /unpublishFailed \+= 1/);
assert.match(base, /hidden: results\.filter\(\(r\) => r\.ok && r\.hidden\)\.length/);
assert.match(route, /publishPublishedListingsToBase\(50/);
assert.match(baseRepair, /base_create_id_persist_failed/ , "BASE identity repair may use the exact ID saved when item creation succeeded but DB persistence failed");
assert.match(baseRepair, /persisted_create_marker/);
assert.match(baseRepair, /identity_evidence_ambiguous/);
assert.match(baseRepair, /snapshot\.complete/, "incomplete BASE snapshots must never be used for identity repair");
assert.match(baseRepair, /\.is\("base_item_id", null\)/, "BASE identity repair must compare-and-set only missing links");
assert.doesNotMatch(baseRepair, /\.update\(\{[^}]*published\s*:/, "BASE identity repair must not change publication state");
// Keep Vercel Cron disabled; guarded 15-minute reconciliation runs through GitHub Actions OIDC.
assert.doesNotMatch(vercel, /"path": "\/api\/cron\/unpublish-unlinked"/);
assert.match(unpublishWorkflow, /cron: "\*\/15 \* \* \* \*"/, "guarded unlinked listing reconciliation must retry every 15 minutes via GitHub Actions");
assert.match(unpublishWorkflow, /api\/cron\/unpublish-unlinked/);
assert.match(unpublishWorkflow, /id-token: write/);
assert.match(unpublishWorkflow, /timeout-minutes: 13/);
assert.doesNotMatch(patrolWorkflow, /^\s{2}schedule:/m, "production patrol must not have a duplicate GitHub Actions schedule");
const vercelPatrolSchedules = JSON.parse(vercel).crons.filter((job) => job.path === "/api/cron/patrol-ai").map((job) => job.schedule);
assert.deepEqual(vercelPatrolSchedules, ["*/5 * * * *"], "the existing Vercel production patrol must still run every five minutes");
const cjIdentitySchedules = JSON.parse(vercel).crons.filter((job) => job.path === "/api/cron/cj-identity-reverify").map((job) => job.schedule);
assert.deepEqual(cjIdentitySchedules, ["12,27,42,57 * * * *"], "CJ identity re-verification must run bounded 25-row batches every 15 minutes, offset from the patrol");
assert.match(patrolWorkflow, /push:/, "core patrol changes must trigger a guarded post-deploy run");
assert.match(patrolWorkflow, /git merge-base --is-ancestor/);
assert.match(patrolWorkflow, /pipelineComplete:/);
assert.match(patrolWorkflow, /r.get\("ok"\) is not True/);
assert.match(patrolWorkflow, /timeout-minutes: 9/);
assert.match(patrolRoute, /const safeSteps = pipeline\.steps\.map/);
assert.match(patrolRoute, /errorCategories: Array\.from\(new Set\(errors\.map/);
assert.match(patrolRoute, /JSON\.stringify\(safeReport\)/);
assert.doesNotMatch(patrolRoute, /console\.log\("\[TRACER PATROL AI REPORT\]", JSON\.stringify\(report\)\)/, "raw full patrol reports must not be emitted to runtime logs");
assert.match(unpublishWorkflow, /fetch-depth: 0/);
assert.match(unpublishWorkflow, /git merge-base --is-ancestor/, "initial reconciliation must accept a newer deployed descendant");
assert.match(unpublishWorkflow, /result\.get\("ok"\) is not True/, "HTTP 207 partial reconciliation results must fail the scheduled job");
console.log("Canonical supplier identity publication and reconciliation checks passed");
