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
assert.match(helper, /export type SupplierListingReference/);
assert.match(helper, /String\(row\.product_id \?\? ""\) === reference\.productId/);
assert.match(helper, /String\(row\.supplier_product_id \?\? ""\) === reference\.supplierProductId/);
assert.match(helper, /String\(row\.supplier_variant_id \?\? ""\) === reference\.supplierVariantId/);
assert.match(helper, /statuses\.set\(reference\.listingId, status\)/, "supplier status must be keyed by the shop listing after exact tuple validation");
assert.match(shopify, /supplierStatuses\.has\(String\(row\.id\)\)/, "Shopify publication must gate each listing by its own verified identity tuple");
assert.match(shopify, /supplier_identity_unlinked/, "Shopify dry-run must expose identity mismatches as a blocking reason");
assert.match(base, /supplierStatuses\.has\(String\(listing\.id\)\)/, "BASE publication must gate each listing by its own verified identity tuple");
assert.match(store, /supplierStatuses\.has\(listing\.id\)/, "storefront must not accept a healthy supplier row linked to a different product");
assert.match(store, /supplierStatuses\.has\(String\(listing\.id\)\)/, "checkout must validate the exact supplier tuple for each listing");
const identityAuditRouteExactTuple = await readFile(new URL("../app/api/admin/shopify/identity-audit/route.ts", import.meta.url), "utf8");
assert.match(identityAuditRouteExactTuple, /internal_product_id_mismatch/);
assert.match(identityAuditRouteExactTuple, /supplier_product_id_mismatch/);
assert.match(identityAuditRouteExactTuple, /supplier_variant_id_mismatch/);
assert.match(persist, /verification_error: nativeEvidenceFresh \? null : \(priorVerificationError && priorVerificationError !== "no_unique_canonical_child_variant_match" \? priorVerificationError : "supplier_native_evidence_pending"\)/, "only fresh, fully verified native supplier evidence may clear the old configuration error; marketplace identity is not required");
assert.match(persist, /shipping_status: Number\.isFinite\(args\.shippingCost\) && args\.shippingCost > 0[\s\S]{0,100}"verified"/, "a fresh positive Japan freight quote must be persisted as verified shipping evidence independently of orderability");
assert.match(discoverCJ, /identity_status: "supply_discovered", identity_confidence: 0/, "supply discovery without canonical identity must not claim perfect identity confidence");
assert.match(discoverCJ, /title: displayTitle, product_id: null/, "CJ supply discovery must persist a Japanese display title without attaching an unrelated marketplace product");
assert.match(discoverCJ, /source_title: detail\.title/, "original supplier title must be retained separately from Japanese storefront copy");
const nativeEvidenceBlock = persist.split("const nativeEvidenceFresh =")[1]?.split("\n\n  let candidateIntelligenceId")[0] ?? "";
assert.ok(nativeEvidenceBlock.length > 0, "fresh CJ evidence predicate must be inspectable");
assert.doesNotMatch(nativeEvidenceBlock, /verification_status === "verified"|priorVerifiedAt/, "fresh live evidence must be able to clear stale verification state instead of requiring the old status to already be verified");
assert.match(persist, /isSpecificJapaneseProductTitle\(existingCandidate\.data\.normalized_title\)/, "generic existing intelligence titles must be replaced with specific Japanese supplier copy");
assert.match(discoverCJ, /const liveOrderPathReady = isCJLiveOrderPathReady\(\)[\s\S]*?orderable: liveOrderPathReady/, "seeded refresh may promote a listing only after fresh exact-variant price, stock, Japan freight and explicit production live-order readiness");
assert.match(discoverCJ, /api_available: isCJLiveOrderPathReady\(\)/, "new CJ supply must respect the explicit production live-order readiness gate");
assert.match(discoverCJ, /orderable: isCJLiveOrderPathReady\(\) && Number\.isFinite\(cost\)[\s\S]*?tracking_available: isCJLiveOrderPathReady\(\)/, "new CJ supply may become orderable only with fresh positive price, stock, Japan freight and configured live-order flags");
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
  assert.doesNotMatch(upsert, /identity_confidence: 1/, "supplier discovery must not claim canonical marketplace identity");
}
assert.match(supplierUpserts[0], /api_available: liveOrderPathReady[\s\S]*?orderable: liveOrderPathReady[\s\S]*?tracking_available: liveOrderPathReady/, "seeded refresh must re-evaluate orderability from fresh exact-variant evidence and the explicit production flags");
assert.match(supplierUpserts[1], /api_available: isCJLiveOrderPathReady\(\)[\s\S]*?orderable: isCJLiveOrderPathReady\(\) &&[\s\S]*?tracking_available: isCJLiveOrderPathReady\(\)/, "newly discovered CJ candidates may enter the live path only when production flags and fresh supply evidence pass");

assert.match(directGate, /\.eq\("identity_status", "linked"\)/, "direct sales-test gate must require canonical supplier identity");
assert.doesNotMatch(directGate, /identity_status\.eq\.supply_discovered/, "supply discovery alone must never enter direct sales-test selection");
assert.match(salesPublicationRoute, /\.eq\("identity_status", "linked"\)/, "sales-test publication prefilter must require linked supplier identity");
assert.match(salesPublicationRoute, /TRACER_CJ_NATIVE_SUPPLY_PUBLICATION_ENABLED !== "false"/, "verified native CJ supply must be publishable by default; only an explicit false setting may disable it");
assert.match(supplySelector, /const pool = verifiedCandidates;/, "sales-test selector must fail closed when no supplier offer passes all verification checks");
assert.doesNotMatch(supplySelector, /verifiedCandidates\.length > 0 \? verifiedCandidates : candidates/, "unverified supplier candidates must never be used as a fallback publication pool");
assert.doesNotMatch(salesPublicationRoute, /identity_status\.eq\.supply_discovered/, "sales-test publication must not prefilter unresolved supply as verified");
assert.match(e2eFunnel, /eq\("identity_status", "linked"\).*eq\("verification_status", "verified"\).*eq\("orderable", true\)/, "readiness funnel must not count unresolved supply as verified and orderable");
assert.match(intelligencePipeline, /\.eq\("verification_status", "verified"\)[\s\S]*?\.eq\("orderable", true\)/, "supply selection must still require verified, orderable supplier evidence");
assert.match(intelligencePipeline, /legacy_shop_listings_disabled_canonical_commerce_only/,
  "patrol must not create legacy BASE-only listings outside the canonical commerce catalog");
assert.doesNotMatch(intelligencePipeline, /allowNativeCjIdentity:\s*true/,
  "legacy patrol selection is disabled; native supplier eligibility is handled by the canonical commerce publisher");
assert.match(intelligencePipeline, /name: "business_readiness"/, "patrol completion must include business readiness, not only successful code stages");
assert.match(intelligencePipeline, /freshOrderableSuppliers: freshOrderableSupplierCount/);
assert.match(intelligencePipeline, /publishedOrderableListings/);
assert.match(intelligencePipeline, /retryable: !businessReady/, "zero orderable supplier/listing counts must keep the pipeline incomplete and retryable");
assert.match(persist, /last_verified_at: nativeEvidenceFresh \? now : existingListing\.data\?\.last_verified_at \?\? null/, "supplier verification timestamps must advance only when native supplier evidence remains fresh");
assert.match(persist, /supplier_native_evidence_pending/);
const reverify = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
assert.match(reverify, /let liveSupplierApiVerified = row\.api_available === true && row\.configured === true/);
assert.match(reverify, /refreshedFields\.configured = true/);
assert.match(reverify, /refreshedFields\.api_available = true/);
assert.match(reverify, /select\("id,product_id,title,sku,cost,shipping_cost/);
assert.match(reverify, /refreshedFields\.sku = variantDetails\.sku\.trim\(\)/);
assert.match(reverify, /supplier orderability and tracking capability remain unverified/);
assert.match(reverify, /supplier orderability and tracking capability remain unverified/);
assert.doesNotMatch(reverify, /refreshedFields\.tracking_available = true/, "live catalog reads must not manufacture tracking proof");
assert.match(reverify, /if \(stockCapHoldRecoverable\) \{[\s\S]{0,120}refreshedFields\.orderable = true;/, "only the explicit deployed stock-cap recovery may restore orderable state");
assert.match(persist, /bestseller_id: null/, "supplier-native CJ persistence must not claim a marketplace parent link");
assert.match(persist, /identity_status: "supply_discovered"/, "CJ supplier-native identity must remain distinct from cross-marketplace identity");
assert.doesNotMatch(persist, /orderable: false, tracking_available: false, api_available: false/, "identity recheck must not erase existing supplier order-path evidence");
assert.match(persist, /catalog_stage: "candidate"/, "unmatched supplier supply must be retained as a catalog candidate");
assert.ok(persist.includes('const nativeIdentityKey = `cj:${args.supplierProductId}:${args.supplierVariantId}`;'), "native candidate linkage must be grounded in the exact CJ product+variant identity key");
assert.doesNotMatch(persist, /\[existingProductId, discoveredProductId\]\.find/, "native candidate persistence must not trust an arbitrary caller-supplied UUID");
assert.match(persist, /purchasable: nativeEvidenceFresh/, "unmatched supply becomes purchasable only when fresh native supplier evidence passes");
assert.match(persist, /const offerPayload = \{ product_id: canonicalProductId, seller_name: "CJdropshipping"/, "supplier-native CJ supply must persist an offer without requiring marketplace identity");
assert.ok(persist.indexOf("const offerPayload = {") < persist.indexOf("const existingOffer ="), "supplier-native offers must be persisted idempotently without a marketplace match");
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
assert.match(shopify, /getPublishableSupplierListingStatuses/, "Shopify publication must require a linked or freshly verified native supplier listing");
assert.match(shopify, /supplierStatuses\.has\(String\(row\.id\)\)/, "Shopify must reject supplier listings without eligible identity evidence");
assert.match(shopify, /nativeCjRepairIds[\s\S]*?supplierStatuses\.get\(String\(row\.id\)\) === "native_cj_verified"/, "Shopify may repair stale local flags only from fresh exact native CJ evidence");
assert.match(shopify, /orderable: true,[\s\S]*?tracking_available: true/, "Shopify recovery must restore both flags only after supplier verification");
assert.doesNotMatch(shopify, /supplier_not_cj/, "profitable linked products from any supplier may be listed");
assert.match(shopify, /supplier_variant_missing/, "exact supplier product and variant IDs remain required");
assert.match(shopify, /inventory_not_positive/, "storefront inventory must be positive");
assert.match(shopify, /profit_not_positive/, "catalog publication requires positive contribution profit");
assert.match(base, /identityUnlinkedIds/);
assert.match(base, /supplier_product_id.not.is.null,supplier_variant_id.not.is.null/, "BASE retries linked catalog rows regardless of old hidden error markers");
assert.match(base, /getPublishableSupplierListingStatuses/, "BASE publication must require a linked or freshly verified native supplier listing");
assert.match(base, /listing\.orderable !== true/, "BASE publication requires supplier orderability");
assert.match(base, /listing\.tracking_available !== true/, "BASE publication requires tracking capability");
assert.match(base, /nativeCjRepairIds[\s\S]*?supplierStatuses\.get\(String\(listing\.id\)\) === "native_cj_verified"/, "BASE may repair stale flags only from fresh exact native CJ evidence");
assert.match(base, /profit_not_positive/, "BASE publication requires positive contribution profit");
assert.match(base, /query\.order\("created_at", \{ ascending: false \}\)/,
  "BASE batches must prioritize new gate-passed listings instead of starving them behind old hidden rows");
assert.match(base, /base_last_error: isIdentityUnlinked \? "supplier_identity_unlinked_hidden" : "tracer_unpublished_hidden"/);
assert.match(store, /supplierStatuses\.has\(listing\.id\)/);
assert.match(store, /supplier_identity_unlinked/);
assert.match(route, /requireAutomationAuth/);
assert.match(route, /TRACER UNLINKED RECONCILIATION/, "production cleanup progress must be observable with count-only telemetry");
assert.match(route, /published: false/);
assert.match(route, /row\.orderable !== true \|\| row\.tracking_available !== true/, "unlinked-channel reconciliation must include supplier offers without an order path or tracking");
assert.match(route, /nativeCjRepairIds[\s\S]*?supplierStatuses\.get\(String\(row\.id\)\) === "native_cj_verified"/, "cleanup must not permanently block a listing after exact native CJ verification is fresh");
assert.match(route, /fetchBaseItemsSnapshot/, "BASE reconciliation must inspect the complete external item catalog");
assert.match(route, /eligibleIdentifiers\.has\(identifier\)/, "BASE must retain only exact TRC identifiers for currently publishable listings");
assert.match(route, /editBaseItem\([\s\S]*?visible: false/, "unmatched BASE items must be hidden, not physically deleted");
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
assert.match(baseRepair, /stale_external_id_repair_requires_explicit_flag/, "stale external BASE IDs require an explicit apply flag");
assert.match(baseRepair, /stale_external_id_absent_from_complete_snapshot/, "stale BASE rebinds require exact SKU plus a complete-snapshot absence proof");
assert.match(baseRepair, /\.is\("base_item_id", null\)/, "BASE identity repair must compare-and-set only missing links");
assert.doesNotMatch(baseRepair, /\.update\(\{[^}]*published\s*:/, "BASE identity repair must not change publication state");
// Keep Vercel Cron disabled; guarded 15-minute reconciliation runs through GitHub Actions OIDC.
assert.doesNotMatch(vercel, /"path": "\/api\/cron\/unpublish-unlinked"/, "use the guarded GitHub Actions reconciliation schedule without a duplicate Vercel cron");
assert.doesNotMatch(vercel, /"path": "\/api\/cron\/(supplier-investigation|demand-match)"/, "supplier discovery and marketplace matching must not run as independent cron sourcing jobs");
assert.doesNotMatch(vercel, /"path": "\/api\/cron\/market-sourcing"/, "marketplace collection must not be scheduled in the supplier-native rebuild");
assert.match(intelligencePipeline, /marketplace_sourcing_disabled_supplier_native_only/, "patrol must not read marketplace-derived sourcing data");
assert.doesNotMatch(vercel, /"path": "\/api\/cron\/newfind-retry"/, "out-of-scope NEWFIND retries must not run in the three-site workflow");
assert.match(intelligencePipeline, /marketplace_sourcing_disabled_supplier_native_only/, "marketplace candidates must not feed publication");
assert.match(unpublishWorkflow, /Disabled after the clean commerce reset/);
assert.match(unpublishWorkflow, /workflow_dispatch/);
assert.match(unpublishWorkflow, /if: \$\{\{ false \}\}/, "legacy reconciliation must stay disabled against the empty legacy listing table");
assert.doesNotMatch(unpublishWorkflow, /cron: "\\*\/15 \\* \\* \\*"/, "legacy reconciliation must not run on a timer");
assert.doesNotMatch(unpublishWorkflow, /api\/cron\/unpublish-unlinked/);
assert.doesNotMatch(patrolWorkflow, /^\s{2}schedule:/m, "production patrol must not have a duplicate GitHub Actions schedule");
const vercelPatrolSchedules = JSON.parse(vercel).crons.filter((job) => job.path === "/api/cron/patrol-ai").map((job) => job.schedule);
assert.deepEqual(vercelPatrolSchedules, ["*/5 * * * *"], "the existing patrol-ai cron must remain enabled every five minutes");
const cleanSupplierSchedules = JSON.parse(vercel).crons.filter((job) => job.path === "/api/cron/commerce-cj-import").map((job) => job.schedule);
assert.deepEqual(cleanSupplierSchedules, ["0,30 * * * *"], "CJ supplier import must retain its configured twice-hourly schedule");
assert.deepEqual(JSON.parse(vercel).crons.filter((job) => job.path === "/api/cron/cj-identity-reverify"), [], "legacy identity re-verification must not run against the cleared legacy supplier table");
assert.match(patrolWorkflow, /push:/, "core patrol changes must trigger a guarded post-deploy run");
assert.match(patrolWorkflow, /git merge-base --is-ancestor/);
assert.match(patrolWorkflow, /pipelineComplete:/);
assert.match(patrolWorkflow, /r.get\("ok"\) is not True/);
assert.match(patrolWorkflow, /timeout-minutes: 9/);
assert.match(patrolRoute, /const safeSteps = pipeline\.steps\.map/);
assert.match(patrolRoute, /technicalDeferredSteps/);
assert.match(patrolRoute, /businessReadinessMissing/, "business readiness gaps must be reported incomplete without masquerading as a technical exception");
assert.match(patrolRoute, /errorCategories: Array\.from\(new Set\(errors\.map/);
assert.match(patrolRoute, /orderLifecycleEvidence: \{/,
  "patrol must report order lifecycle evidence separately from intelligence-pipeline completion");
assert.match(patrolRoute, /tracerBaseFulfillmentGroups/);
assert.match(patrolRoute, /tracerShopifyFulfillmentGroups/);
assert.match(patrolRoute, /trackingWritebackOrdersRecorded: after\.trackingWritebackOrders/,
  "completion status must include persisted channel tracking writeback evidence");
assert.match(patrolRoute, /endToEndPipelineComplete: after\.commerceOrders > 0 && after\.supplierProcurementOrders > 0 && after\.trackingWritebackOrders > 0/,
  "end-to-end completion requires an order, supplier procurement and tracking writeback");
assert.doesNotMatch(patrolRoute, /pipelineComplete: pipeline\.complete/,
  "intelligence completion must not be reported as the whole commerce lifecycle");
assert.match(patrolRoute, /endToEndOrderFlowObservedThisRun: progress\.newCommerceOrders > 0 && progress\.newSupplierProcurementOrders > 0/,
  "end-to-end order flow must only be reported when this run records both a commerce order and supplier procurement order");
assert.match(patrolRoute, /commerceEndToEndComplete: pipeline\.complete\s*&&\s*errors\.length === 0\s*&&\s*after\.commerceOrders > 0\s*&&\s*after\.supplierProcurementOrders > 0/,
  "a successful intelligence patrol must not be reported as end-to-end commerce complete without real order and supplier procurement records");
assert.match(patrolRoute, /JSON\.stringify\(safeReport\)/);
assert.doesNotMatch(patrolRoute, /console\.log\("\[TRACER PATROL AI REPORT\]", JSON\.stringify\(report\)\)/, "raw full patrol reports must not be emitted to runtime logs");
console.log("Canonical supplier identity publication and reconciliation checks passed");


// Bright Data's market research remains observation-only; it cannot establish supplier identity or publication eligibility.
const marketSourcingRouteForBrightData = await readFile(new URL("../app/api/cron/market-sourcing/route.ts", import.meta.url), "utf8");
assert.match(marketSourcingRouteForBrightData, /reason: "observation_only"/);
assert.doesNotMatch(marketSourcingRouteForBrightData, /selectAndPublishSalesTests|promoteShopListingToNewfind/);


// The read-only identity audit must explain why exact, supplier-linked rows are not Shopify-sync eligible.
const identityAuditRoute = await readFile(new URL("../app/api/admin/shopify/identity-audit/route.ts", import.meta.url), "utf8");
assert.match(identityAuditRoute, /nativeCjPublicationReadiness/);
assert.match(identityAuditRoute, /shipping_status !== "verified"/);
assert.match(identityAuditRoute, /configured !== true/);
assert.match(identityAuditRoute, /referenced\.ship_to[\s\S]*?!== "JP"/);
assert.match(identityAuditRoute, /supplier_verification_missing_or_stale/);
assert.match(identityAuditRoute, /nativePublicationBlockReasonCounts/);
assert.match(identityAuditRoute, /blockReasons: nativeBlockReasons/);


// Targeted re-verification may refresh only explicitly named supplier rows, without advancing the global cursor.
const reverifyImplementation = await readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8");
const reverifyRoute = await readFile(new URL("../app/api/cron/cj-identity-reverify/route.ts", import.meta.url), "utf8");
assert.match(reverifyImplementation, /supplierListingIds\?: string\[\]/);
assert.match(reverifyImplementation, /targetSupplierListingIds\.length > 0[\s\S]*?buildCandidateQuery\(\)\.in\("id", targetSupplierListingIds\)/);
assert.match(reverifyImplementation, /targetSupplierListingIds\.length > 0\) result\.nextCursor = priorCursor/);
assert.match(reverifyImplementation, /selectionStrategy: targetSupplierListingIds\.length > 0 \? "explicit_supplier_listing_ids"/);
assert.match(reverifyRoute, /url\.searchParams\.get\("supplierListingIds"\)/);
assert.match(reverifyRoute, /supplierListingIds,/);
assert.match(reverifyRoute, /targetedListingCount: supplierListingIds\.length/);


// The one-shot recovery workflow may refresh only the audited supplier rows and must never publish or order.
const targetedReverifyWorkflow = await readFile(new URL("../.github/workflows/tracer-targeted-cj-reverify-six.yml", import.meta.url), "utf8");
assert.match(targetedReverifyWorkflow, /if: contains\(github\.event\.head_commit\.message, 'reverify the six blocked Shopify supplier rows by exact ID'\)/);
assert.match(targetedReverifyWorkflow, /supplierListingIds=\$IDS/);
assert.match(targetedReverifyWorkflow, /'\{"dryRun":true,"limit":1000\}'/);
assert.doesNotMatch(targetedReverifyWorkflow, /api\/cron\/commerce-procurement|api\/cron\/shopify-orders/);
assert.match(targetedReverifyWorkflow, /No Shopify product write, unpublish, supplier order, or payment was requested/);

assert.match(identityAuditRoute, /shipping_status,configured,ship_to/,
  "native readiness audit must actually select the shipping/configuration/destination fields it evaluates");


// The six-listing publication workflow must intersect native CJ readiness with the dry-run gate and use bounded batches.
const sixListingPublishWorkflow = await readFile(new URL("../.github/workflows/tracer-shopify-publish-six-ready.yml", import.meta.url), "utf8");
assert.match(sixListingPublishWorkflow, /if: contains\(github\.event\.head_commit\.message, 'publish the six CJ-ready Shopify listings'\)/);
assert.match(sixListingPublishWorkflow, /row\.get\("eligible"\) is True and item\.get\("eligible"\) is True/);
assert.match(sixListingPublishWorkflow, /ids = ids\[:6\]/);
assert.match(sixListingPublishWorkflow, /ids\[i:i\+3\]/, "Shopify product sync must use batches of three to reduce timeout risk");
assert.match(sixListingPublishWorkflow, /-d "@publish-batch-\$index\.json"/);
assert.doesNotMatch(sixListingPublishWorkflow, /api\/cron\/commerce-procurement|api\/cron\/shopify-orders/);
assert.match(sixListingPublishWorkflow, /Block(ed|ed) listings were not sent/);


// Terminal supplier offers must not be pulled back into the recurring publish retry queue.
const commercePublishRecovery = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
assert.match(commercePublishRecovery, /\.or\("status\.eq\.pending,last_error\.like\.supplier_offer_not_fulfillable%,last_error\.eq\.japanese_product_title_invalid"\)/,
  "only pending rows and explicitly retryable supplier-offer or Japanese-title errors may enter the bounded recovery queue");
assert.doesNotMatch(commercePublishRecovery, /\.or\("status\.eq\.pending,status\.eq\.error,last_error\.like\.supplier_offer_not_fulfillable%"\)/,
  "terminal supplier_offer_no_longer_fulfillable errors must not be retried on every publish pass");
