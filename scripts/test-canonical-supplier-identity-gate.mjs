import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [helper, shopify, base, store, route, vercel, persist, demandCJ, demandSupplier, unpublishWorkflow, patrolWorkflow, patrolRoute, discoverCJ, directGate, salesPublicationRoute, e2eFunnel, intelligencePipeline, baseRepair] = await Promise.all([
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
]);
assert.match(helper, /identity_status === "linked"/);
assert.match(helper, /isNativeVerifiedSupplierListing/ , "publication identity must be shared by all supported suppliers with the same strict evidence contract");
assert.match(helper, /native_supplier_verified/, "verified non-CJ supplier identities must survive publication-status lookup");
assert.match(shopify, /native_supplier_verified/, "Shopify sync must accept a strict verified native supplier identity");
assert.doesNotMatch(shopify, /supplier_not_cj/, "verified non-CJ suppliers must not be excluded by a stale hardcoded channel gate");
assert.match(shopify, /supplier_unknown/, "supplier identity still requires an explicit supplier name");

assert.match(helper, /row\.shipping_status === "estimated"[\s\S]{0,300}metadata\.shipping_estimate_applied === true/, "an explicit conservative freight reserve may enter the native CJ sale path");
assert.match(helper, /shipping_status,configured,price_confirmed[\s\S]{0,200}metadata/, "publication identity lookup must include reserve evidence");

assert.doesNotMatch(persist, /verification_error:\s*marketplaceIdentity/, "marketplace identity uncertainty must not be recorded as supplier verification failure");
assert.doesNotMatch(persist, /verification_status:\s*marketplaceIdentity\s*\?\s*"verified"\s*:\s*"unverified"/, "identity persistence must not overwrite the independent supplier verification state");
assert.match(discoverCJ, /identity_status: "supply_discovered", identity_confidence: 0/, "supply discovery without canonical identity must not claim perfect identity confidence");
assert.match(discoverCJ, /title: detail\.title, product_id: null/, "CJ supply discovery must not provisionally attach a canonical product ID before identity is resolved");
assert.match(discoverCJ, /api_available: true, verification_status: "verified"/, "live-verified CJ supply must record supplier API and verification state independently of marketplace identity");
assert.match(discoverCJ, /orderable: true, price_confirmed: true, inventory_confirmed: true, tracking_available: cjTrackingAvailable/, "a live exact CJ variant with positive stock and verified Japan freight must retain its supplier order path");
assert.match(discoverCJ, /identity_status: "supply_discovered"/, "supplier verification must not falsely promote marketplace identity");

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
  assert.match(upsert, /api_available: true/);
  assert.match(upsert, /orderable: true/);
  assert.match(upsert, /tracking_available: cjTrackingAvailable/);
  assert.match(upsert, /verification_error: null/);
  assert.match(upsert, /shipping_status: "verified"/);
  assert.match(upsert, /last_verified_at:/);
  assert.doesNotMatch(upsert, /identity_confidence: 1/, "native CJ orderability must not imply marketplace identity");
}

assert.match(directGate, /\.eq\("identity_status", "linked"\)/, "direct sales-test gate must require canonical supplier identity");
assert.doesNotMatch(directGate, /identity_status\.eq\.supply_discovered/, "supply discovery alone must never enter direct sales-test selection");
assert.match(salesPublicationRoute, /\.eq\("identity_status", "linked"\)/, "sales-test publication prefilter must require linked supplier identity");
assert.doesNotMatch(salesPublicationRoute, /identity_status\.eq\.supply_discovered/, "sales-test publication must not prefilter unresolved supply as verified");
assert.match(e2eFunnel, /eq\("identity_status", "linked"\).*eq\("verification_status", "verified"\).*eq\("orderable", true\)/, "readiness funnel must not count unresolved supply as verified and orderable");
assert.match(intelligencePipeline, /\.eq\("verification_status", "verified"\)[\s\S]*?\.eq\("orderable", true\)/, "supply selection must still require verified, orderable supplier evidence");
assert.match(intelligencePipeline, /selectAndPublishSupplySalesTests\(supplyCandidateIds, 50, \{ allowNativeCjIdentity: true \}\)/, "native CJ products must use the same strict evidence gate in the intelligence cron without a separate feature flag");
assert.doesNotMatch(intelligencePipeline, /TRACER_CJ_NATIVE_SUPPLY_PUBLICATION_ENABLED/, "no stale CJ-native publication flag may block the intelligence path");
assert.match(persist, /last_verified_at: now/, "CJ verification must refresh its timestamp");
assert.match(persist, /bestseller_id: marketplaceIdentity\?\.bestsellerId \?\? null/, "unmatched or ambiguous CJ identity must clear any stale canonical parent link");
assert.match(persist, /identity_status: marketplaceIdentity \? "linked" : "supply_discovered"/, "CJ discovery alone must not promote supplier identity to linked");
assert.doesNotMatch(persist, /orderable: false, tracking_available: false, api_available: false/, "identity recheck must not erase existing supplier order-path evidence");
assert.match(persist, /if \(!marketplaceIdentity\)[\s\S]*?return \{ offerId: null, intelligenceId: String\(candidate\.data\.id\), identity: null \}/, "unmatched CJ identity may retain a non-purchasable supplier-native candidate but must not create a product offer");
assert.ok(persist.indexOf("if (!marketplaceIdentity)") < persist.indexOf("const offerPayload = {"), "supplier-native candidate retention must exit before any product_offers write");
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
assert.match(shopify, /supplier_identity_unlinked/);
assert.match(shopify, /hasPublishableSupplierIdentity/);
assert.match(shopify, /pipeline_stage\.eq\.BASE_PUBLISHED/, "BASE_PUBLISHED rows must remain eligible for downstream Shopify reconciliation");
assert.match(shopify, /Math\.min\(Math\.max\(Math\.floor\(limit\), 1\), 25\)/, "Shopify reconciliation should process a useful bounded batch without unbounded API pressure");
assert.match(shopify, /\["PUBLISHED", "BASE_PUBLISHED"\]\.includes\(String\(row\.pipeline_stage\)\)/, "published BASE listings must not be starved from Shopify sync merely because their pipeline stage records the BASE result");

assert.match(shopify, /native_cj_verified/);
assert.match(base, /identityUnlinkedIds/);
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
assert.match(patrolWorkflow, /cron: "\*\/5 \* \* \* \*"/, "production patrol must run every five minutes");
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
