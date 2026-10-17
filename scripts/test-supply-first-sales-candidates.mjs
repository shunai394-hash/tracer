import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pipeline = readFileSync("lib/intelligence/run-intelligence-pipeline.ts", "utf8");
const selector = readFileSync("lib/market/select-supply-sales-tests.ts", "utf8");
const marketSelector = readFileSync("lib/market/select-sales-tests.ts", "utf8");
const pricing = readFileSync("lib/market/supply-pricing.ts", "utf8");
const identity = readFileSync("lib/catalog/canonical-supplier-identity.ts", "utf8");
const japaneseProduct = readFileSync("lib/intelligence/japanese-product.ts", "utf8");
const internalSupply = readFileSync("lib/suppliers/persist-cj-internal-supply.ts", "utf8");
assert.match(internalSupply, /Number\.isFinite\(args\.shippingUsd\) \|\| args\.shippingUsd < 0/, "verified zero-cost supplier freight is valid; only negative or non-finite freight is rejected");
const commerceCycle = readFileSync(".github/workflows/tracer-autonomous-commerce-cycle.yml", "utf8");
const oneShotRecovery = readFileSync(".github/workflows/tracer-one-shot-supply-recovery.yml", "utf8");
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
const patrol = readFileSync("app/api/cron/patrol-ai/route.ts", "utf8");
assert.match(patrol, /\["PUBLISHED", "BASE_PUBLISHED", "SHOPIFY_PUBLISHED"\]/, "patrol eligibility metrics must recognize current publication stages");
assert.match(patrol, /"profitable_supplier_linked_catalog"/, "patrol eligibility metrics must recognize the current publisher reason");

// The supply-first queue must not require a marketplace identity link: a
// standalone CJ catalog item can be sellable once its own exact variant and
// current supplier/economic evidence pass the native-CJ gate.
assert.match(pipeline, /\.eq\("verification_status",\s*"verified"\)/);
assert.match(pipeline, /\.eq\("shipping_status",\s*"verified"\)/);
assert.match(pipeline, /\.eq\("price_confirmed",\s*true\)/);
assert.match(pipeline, /\.eq\("inventory_confirmed",\s*true\)/);
assert.match(pipeline, /\.eq\("orderable",\s*true\)/);
assert.match(pipeline, /\.eq\("tracking_available",\s*true\)/);
assert.match(pipeline, /\.eq\("api_available",\s*true\)/);
assert.match(pipeline, /\.not\("supplier_product_id",\s*"is",\s*null\)/);
assert.match(pipeline, /\.not\("supplier_variant_id",\s*"is",\s*null\)/);
assert.match(pipeline, /\.gte\("last_verified_at",\s*freshSupplyCutoff\)/);
assert.match(pipeline, /selectAndPublishSupplySalesTests\(supplyCandidateIds,\s*50,\s*\{\s*allowNativeCjIdentity:\s*true\s*\}\)/);
const salesRoute = readFileSync("app/api/cron/sales-test-publication/route.ts", "utf8");
assert.match(salesRoute, /mode: "canonical_supply_fast_path"/, "cron telemetry must name the supply-first path it actually runs");
assert.doesNotMatch(salesRoute, /mode: "market_linked_sales_test"/, "cron telemetry must not mislabel supply-first runs as market-linked-only");
assert.match(salesRoute, /nativeSourceRefs/);
assert.ok(salesRoute.includes("`cj:product:${productId}:variant:${variantId}`"));
assert.match(salesRoute, /nativeProductBySourceRef\.get\(sourceRef\)/);
assert.match(salesRoute, /const sourceRef = productId && variantId \? `cj:product:\$\{productId\}:variant:\$\{variantId\}` : ""/, "native CJ product lookup must use the same labeled source_ref format as product identity_key");
const nativeCjPublicationBlock = salesRoute.slice(salesRoute.indexOf("const { data: nativeCjSupplyRows"), salesRoute.indexOf("const verifiedSupplyIds"));
assert.doesNotMatch(nativeCjPublicationBlock, /\.not\("product_id",\s*"is",\s*null\)/, "standalone CJ supply resolves its TRACER product only by exact source_ref");
assert.match(selector, /options\.allowNativeCjIdentity\s*===\s*true/);
assert.match(selector, /sourceRefToProductId/, "native supply candidates resolve their TRACER-owned product by deterministic source_ref");
assert.match(selector, /metadata->>source_ref/, "detached supply listings are queried without writing marketplace identity");
assert.match(selector, /supplier_listings\.product_id null until marketplace identity is proven/, "detached offers remain detached in the database");
// Demand/opportunity intelligence is ranking-only, not a listing prerequisite.
assert.match(selector, /const intelligence = intelligenceByProduct.get\(productId\) \?\?/);
assert.match(selector, /Supplier-native products may not have a product_intelligence row yet/, "supplier-native title/image evidence can provide a fallback catalog record when enrichment is missing");
assert.match(selector, /product_intelligence_or_supplier_catalog_missing/, "missing enrichment is only rejected when neither catalog nor supplier title exists");
assert.doesNotMatch(selector, /if \(!intelligence\) reasons\.push\("opportunity_intelligence_missing"\)/);
assert.doesNotMatch(selector, /sellability_not_ready|intelligence_filter_not_pass|intelligence_profit_not_ok|demand_evidence_missing|search_fit_evidence_missing|market_gap_evidence_missing|intelligence_confidence_low/, "AI demand scores must not suppress an otherwise profitable and fulfilment-ready product");
assert.doesNotMatch(selector, /outside_womens_product_strategy/, "women-focused priority must not exclude other profitable categories");
assert.doesNotMatch(marketSelector, /outside_womens_product_strategy/, "market-linked publication must not exclude other profitable categories either");
assert.match(selector, /isNativeCjSupplierListing\(candidate\)/);
assert.match(identity, /row\.verification_status === "verified"/);
assert.match(identity, /row\.shipping_status === "verified"/);
assert.match(identity, /row\.last_verified_at/);
assert.match(identity, /row\.supplier_product_id/);
assert.match(identity, /row\.supplier_variant_id/);
assert.match(selector, /Boolean\(candidate\.supplier_product_id\)/);
assert.match(selector, /Boolean\(candidate\.supplier_variant_id\)/);
assert.match(selector, /domesticShipping: nativeCjSupplyIdentity \? 0 : null/);
assert.match(selector, /resolveUnknownShippingAllowanceUsd\(process\.env\.TRACER_CJ_UNKNOWN_SHIPPING_ALLOWANCE_USD\)/, "unknown CJ freight must use a configurable non-zero allowance");
assert.match(selector, /persistedListingShippingCost\(\{ supplierShippingCost: num\(item\.listing\.shipping_cost\), convertedInternationalShipping: item\.profit\.internationalShipping \}\)/, "real supplier freight must be persisted in selling currency; estimated freight stays null");
assert.match(selector, /profitCalculable: profit\\.calculable, shippingUnknown: profit\\.shippingUnknown, contributionProfit: profit\\.contributionProfit/, "a conservative shipping allowance supports landed-price calculation");
assert.match(selector, /\.\.\.\(shippingEstimateReason \? \[shippingEstimateReason\] : \[\]\)/, "published listings retain an explicit estimated-shipping disclosure");
assert.doesNotMatch(selector, /selection_reasons: \[[^\]]*"profit_not_positive"/, "a published listing must not carry a non-positive profit marker");
assert.match(selector, /calculateSupplySellingPriceJpy\(/, "missing selling prices must flow through the tested landed-price calculator");
assert.match(selector, /supplierMetadata\.image_url/ , "use the verified supplier image stored in metadata when the product master has no image");
assert.match(selector, /image_url: item\.imageUrl/, "the selected supplier image must be the image persisted to the storefront listing");
assert.match(pricing, /const landedCostJpy = \(sourceCost \+ shippingCost\) \* sourceFxRateToSelling/, "landed price must use the shipping amount actually passed to profit simulation");
assert.doesNotMatch(selector, /product_master_title_not_publishable|product_master_title_missing/, "a generic legacy product-master title must not block a concrete supplier title");
assert.match(selector, /generic_non_merchandisable_title/, "true placeholder supplier titles must still be blocked");
assert.match(selector, /localizeProductDescription\(sourceTitle\)/);
assert.match(selector, /isPublishableCatalogDescription\(localizedDescription\)/);
assert.match(selector, /if \(!publishableDescription\)/);
assert.match(japaneseProduct, /knitted headband.*women/i);
assert.match(japaneseProduct, /柔らかなニット素材のクロスヘアバンドです/);
const discovery = readFileSync("lib/suppliers/discover-cj-supply.ts", "utf8");
assert.match(discovery, /women hobo bag/);
assert.match(discovery, /electric face cleansing brush/);
assert.match(discovery, /hair pins women/);
assert.match(discovery, /supply-first-catalog-cursor-v3/, "query-order changes must reset the persisted discovery cursor");
assert.match(selector, /query: typeof sourceMetadata\.query/);
assert.match(selector, /query: typeof metadataA\.query/);
assert.match(selector, /query: typeof metadataB\.query/);

assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/orosy-bulk-import"), [], "Orosy sourcing must stay disabled");
assert.doesNotMatch(commerceCycle, /orosy-bulk-import/, "autonomous commerce workflow must not invoke Orosy");
assert.doesNotMatch(oneShotRecovery, /orosy-bulk-import/, "one-shot recovery must not invoke Orosy");

const cleanImportSchedules = vercel.crons.filter((job) => job.path === "/api/cron/commerce-cj-import").map((job) => job.schedule);
assert.deepEqual(cleanImportSchedules, ["*/10 * * * *"], "clean supplier-native discovery must run every 10 minutes");
assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/supply-first"), [], "legacy supply-first cron must not run beside the clean importer");
assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/market-sourcing"), [], "legacy marketplace observation cron must not run beside clean supplier discovery");
const patrolSchedules = vercel.crons.filter((job) => job.path === "/api/cron/patrol-ai").map((job) => job.schedule);
assert.deepEqual(patrolSchedules, ["*/5 * * * *"], "keep the required five-minute AI patrol alongside the clean commerce pipeline");
const githubPatrolWorkflow = readFileSync(".github/workflows/tracer-production-patrol-15m.yml", "utf8");
assert.doesNotMatch(githubPatrolWorkflow, /^\s{2}schedule:/m, "GitHub Actions must not schedule a second production patrol that races the Vercel Cron");
assert.match(githubPatrolWorkflow, /if: github\.event_name == 'workflow_dispatch'/, "manual production patrol remains available");

console.log("Supply-first candidate selection contract passed.");

assert.match(selector, /profitCalculable: profit\\.calculable, shippingUnknown: profit\\.shippingUnknown, contributionProfit: profit\\.contributionProfit/, "a conservative shipping allowance supports landed-price calculation");
