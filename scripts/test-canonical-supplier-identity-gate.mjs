import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [helper, shopify, base, store, route, vercel, persist, demandCJ, demandSupplier, unpublishWorkflow, patrolWorkflow, patrolRoute, reverify] = await Promise.all([
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
  readFile(new URL("../lib/suppliers/reverify-cj-identity.ts", import.meta.url), "utf8"),
]);
assert.match(helper, /identity_status === "linked"/);
assert.match(reverify, /typeof row\.product_id === "string" && row\.product_id\.trim\(\) \? row\.product_id : ""/, "null or blank legacy product IDs must not become truthy fallback IDs");
assert.match(reverify, /productId: identity\?\.productId \?\? fallbackProductId/, "identity persistence must use the validated fallback product ID");
assert.doesNotMatch(reverify, /String\(row\.product_id\)/, "reverification must not coerce a null product ID to the string null");
assert.ok(reverify.indexOf("if (!canonicalProductId)") < reverify.indexOf('.from("product_intelligence")'), "missing canonical product ID must exit before reading product-linked intelligence");
assert.match(persist, /verification_error: marketplaceIdentity \? null : "no_unique_canonical_child_variant_match"/, "unmatched CJ identity must persist an explicit reason rather than retaining stale verification state");
assert.match(persist, /schema_org_product_is_variant_of/, "CJ canonical identity resolution must accept isVariantOf evidence");
assert.match(persist, /last_verified_at: now/, "CJ verification must refresh its timestamp");
assert.match(persist, /supplierBarcode: barcode/, "resolved canonical identity must carry the exact fresh supplier-variant barcode used for matching");
assert.match(persist, /const verifiedVariantBarcode = marketplaceIdentity\?\.supplierBarcode \?\? await readSupplierBarcode/, "persistence must reuse the exact barcode that proved identity instead of performing a second live read");
assert.match(persist, /variant_barcode: verifiedVariantBarcode/, "stored supplier evidence must retain the same barcode used for canonical matching");
assert.match(persist, /\.select\("id"\)\.maybeSingle\(\)/, "supplier evidence update must confirm that a listing row was actually updated");
assert.match(persist, /if \(!evidenceRow\?\.id\) throw new Error\("CJ supplier evidence persistence failed: supplier listing row was not updated"\)/, "a missing supplier listing must fail instead of silently reporting persistence success");
assert.match(persist, /bestseller_id: marketplaceIdentity\?\.bestsellerId \?\? null/, "unmatched or ambiguous CJ identity must clear any stale canonical parent link");
assert.match(persist, /identity_status: marketplaceIdentity \? "linked" : "supply_discovered"/, "CJ discovery alone must not promote supplier identity to linked");
assert.match(persist, /orderable: false, tracking_available: false, api_available: false/, "identity recheck must not enable purchasing or claim order-path verification");
assert.match(persist, /if \(!marketplaceIdentity\) return \{ offerId: null, intelligenceId: null, identity: null \}/, "unmatched or ambiguous CJ identity must not create product-linked offer/intelligence rows");
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
assert.match(shopify, /supplier_identity_unlinked/);
assert.match(shopify, /identity_status !== "linked"/);
assert.match(base, /identityUnlinkedIds/);
assert.match(base, /base_last_error: isIdentityUnlinked \? "supplier_identity_unlinked_hidden" : "tracer_unpublished_hidden"/);
assert.match(store, /supplierListingId && linkedSupplierIds\.has/);
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
// Keep Vercel Cron disabled; guarded 15-minute reconciliation runs through GitHub Actions OIDC.
assert.doesNotMatch(vercel, /"path": "\/api\/cron\/unpublish-unlinked"/);
assert.match(unpublishWorkflow, /cron: "\*\/15 \* \* \* \*"/, "guarded unlinked listing reconciliation must retry every 15 minutes via GitHub Actions");
assert.match(unpublishWorkflow, /api\/cron\/unpublish-unlinked/);
assert.match(unpublishWorkflow, /id-token: write/);
assert.match(unpublishWorkflow, /timeout-minutes: 13/);
assert.match(patrolWorkflow, /cron: "\*\/15 \* \* \* \*"/);
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
