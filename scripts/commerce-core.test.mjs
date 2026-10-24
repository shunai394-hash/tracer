import test from "node:test";
import assert from "node:assert/strict";
import { selectRotatingVariantBatch } from "../lib/commerce/variant-batch.ts";
import { asRelationRows } from "../lib/commerce/relation-rows.ts";
import { readFile } from "node:fs/promises";
import { calculateSellingPrice } from "../lib/commerce/pricing.mjs";
import { splitJapaneseAddress } from "../lib/commerce/japanese-address.mjs";
import { isCanonicalCJNativeId } from "../lib/sources/cj/native-id.mjs";
import { japaneseCommerceDescription } from "../lib/commerce/japanese-copy.mjs";
import { resolveBasePublicUrl } from "../lib/commerce/base-public-url.mjs";

test("localizes the known Maruki side-clip hair accessory from its source title", async () => {
  const japaneseProduct = await readFile(new URL("../lib/intelligence/japanese-product.ts", import.meta.url), "utf8");
  assert.match(japaneseProduct, /maruki hair accessories with side clips/i);
  assert.match(japaneseProduct, /サイドクリップ付きヘアアクセサリー/);
});

test("known detailed CJ hair-accessory titles stay differentiated in Japanese instead of generic category labels", async () => {
  const japaneseProduct = await readFile(new URL("../lib/intelligence/japanese-product.ts", import.meta.url), "utf8");
  assert.match(japaneseProduct, /ハート・星モチーフ メタルヘアクリップ/);
  assert.match(japaneseProduct, /手編み風 キャンディモチーフ ヘアクリップ/);
  assert.match(japaneseProduct, /サテンリボン ヘアクリップ/);
  assert.match(japaneseProduct, /マットカラー ヘアクリップ 6本セット/);
  assert.match(japaneseProduct, /ゴールドカラー 幾何学透かし模様 メタルヘアクリップ/);
});

test("CJ catalog repair replaces generic category titles with source-specific Japanese titles", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(route, /function sourceSpecificFallbackTitle/);
  assert.match(route, /function repairGenericCommerceTitles/);
  assert.match(route, /metadata\.sourceTitle/);
  assert.match(route, /GENERIC_TITLE_REPAIR_FAILED/);
  assert.match(route, /generic_title_repair_variant_write_failed/);
  assert.match(route, /レディース クロスボディバッグ/);
  assert.match(route, /電動クリーナー/);
});

test("CJ import prioritizes supplier refreshes for existing BASE/Shopify publication failures", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(route, /from\("channel_listings"\)\.select\("variant_id,channel,last_error"\)/);
  assert.match(route, /publicationErrorVariantIds/);
  assert.match(route, /aBlocked - bBlocked/);
  assert.match(route, /Refresh every stale verified offer, including variants without a storefront listing/);
  assert.doesNotMatch(route, /if \(!shopifyVariantIds\.has\(String\(offer\.variant_id\)\) && !publicationErrorVariantIds\.has\(String\(offer\.variant_id\)\)\) continue/);
  assert.match(route, /\[\.\.\.evidenceRetryCandidates, \.\.\.staleListingRetryCandidates\]/);
});

test("CJ freight parsing searches nested object and array wrappers and preserves explicit free-shipping values", async () => {
  const client = await readFile(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
  assert.match(client, /function collectCJFreightRows\(value: unknown\)/);
  assert.match(client, /Object\.values\(record\)\.flatMap\(\(nested\) => collectCJFreightRows\(nested\)\)/);
  assert.match(client, /CJ_FREIGHT_PRICE_KEYS\.some\(\(key\) => readCJFreightPrice\(record\[key\]\) !== null\)/);
  assert.match(client, /const rows = collectCJFreightRows\(payload\.data\)/);
  assert.match(client, /const shippingCost = CJ_FREIGHT_PRICE_KEYS/);
  assert.match(client, /readCJFreightPrice\(record\[key\]\)/);
});

test("price calculation preserves positive profit after fees and target margin", () => {
  const result = calculateSellingPrice({ unitCostJpy: 2000, shippingCostJpy: 500, feeRate: 0.1, targetMarginRate: 0.5 });
  assert.ok(result.sellingPrice > 2500);
  assert.ok(result.expectedProfit > 0);
  assert.ok(result.marginRate >= 0.5);
});
test("repricing prefers fresh verified supplier offers over stale offers pinned by the current price", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.match(route, /last_checked_at,raw_data,updated_at/);
  assert.match(route, /const isFulfillable = \(candidate: typeof offer\)/);
  assert.match(route, /Date\.now\(\) - checkedAt <= 24 \* 60 \* 60_000/);
  assert.match(route, /offerReady && !existingReady/);
  assert.match(route, /Prefer a fresh, verified, Japan-shippable offer over a stale offer pinned by/);
});

test("canonical repricing uses the highest existing storefront price and preserves the 50% net-margin floor", async () => {
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  const start = core.indexOf("export async function recalculatePrice");
  const end = core.indexOf("/** Channel state is independent.", start);
  const pricing = core.slice(start, end);
  assert.match(pricing, /from\("channel_listings"\)[\s\S]*?\.eq\("variant_id", input\.variantId\)/);
  assert.match(pricing, /Math\.max\(minimumPrice\.sellingPrice, highestExistingPrice\)/);
  assert.match(pricing, /marginRate \+ Number\.EPSILON < \(input\.targetMarginRate \?\? 0\.5\)/);
});
test("keeps calculated storefront prices at or above BASE minimum ¥50", () => {
  const result = calculateSellingPrice({ unitCostJpy: 0, shippingCostJpy: 0, feeRate: 0.1, targetMarginRate: 0.5 });
  assert.ok(result.sellingPrice >= 50);
  assert.ok(result.expectedProfit > 0);
  assert.ok(result.marginRate >= 0.5);
});

test("rejects invalid rates", () => {
  assert.throws(() => calculateSellingPrice({ unitCostJpy: 100, shippingCostJpy: 0, feeRate: 1, targetMarginRate: 0.1 }), /invalid_rate/);
});
test("rejects negative costs", () => {
  assert.throws(() => calculateSellingPrice({ unitCostJpy: -1, shippingCostJpy: 0, feeRate: 0.1 }), /invalid_unitCostJpy/);
});


test("CJ importer repairs the mixed-language cosmetic brush cleaner title before channel publication", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(route, /cosmetic brush cleaner/);
  assert.match(route, /メイクブラシクリーナー/);
  assert.match(route, /"コスメ ブラシ Cleaner"/);
});

test("storefront publication requires exact supplier identity and evidenced landed costs, not cached stock or tracking", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/products/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(publish, /supplier_live_ordering_disabled_until_sandbox_payment_flow_proof/);
  assert.doesNotMatch(publish, /commerce_prices\.expected_profit", 0/);
  assert.match(publish, /missingSaleEvidence\(/);
  assert.match(publish, /x\.supplier_product_id && x\.supplier_variant_id && nativeIdsValid/);
  assert.match(publish, /unitCostKnown/);
  assert.match(publish, /x\.raw_data\?\.shippingKnown === true/);
  assert.match(publish, /offer\.tracking_supported === true/);
  assert.doesNotMatch(publish, /offer\.source_status === "verified" && nativeIdsValid/);
  assert.match(publish, /const supplierShippingKnown =/);
  assert.match(publish, /const supplierStockKnown =/);
  assert.match(publish, /const supplierSaleable = supplierShippingKnown && supplierStockKnown/);
  assert.match(publish, /offer\.source_status === "verified"/);
  assert.match(publish, /offer\.ship_to === "JP"/);
  assert.match(publish, /offer\.tracking_supported === true/);
  assert.doesNotMatch(publish, /supplierEvidenceFresh|preflightFresh|priceFresh/);
  assert.doesNotMatch(publish, /Date\.now\(\) - (?:supplierCheckedAt|preflightCheckedAt|checkedAt|priceAt) <= (?:24|7) \* 60 \* 60_000/);
  assert.match(publish, /shippingKnown && stockKnown && offer\.ship_to === "JP"/);
  assert.match(publish, /Number\(price\.expected_profit\) > 0/);
  assert.doesNotMatch(publish, /Math\.max\(1, Number\(offer\.inventory\) \|\| 0\)/);
  assert.match(publish, /shippingInclusiveDescription/);
  assert.match(publish, /日本向け送料は商品価格に含まれています/);
  assert.doesNotMatch(publish, /現在、仕入先の日本向け送料を再確認中のため、購入できません。確認が完了次第、販売を再開します。/);
  assert.doesNotMatch(dashboard, /offer\.tracking_supported === true/);
  assert.doesNotMatch(dashboard, /Number\(offer\.inventory\) > 0/);
  assert.match(dashboard, /offer\.raw_data\?\.shippingKnown === true/);
});

test("new storefront candidates require evidenced landed costs and exact supplier identity", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /supplier_offers\([^)]*raw_data/);
  assert.doesNotMatch(publish, /supplier_offers!inner\(/);
  assert.match(publish, /const validOffers = asRelationRows\(candidate\.supplier_offers\)/);
  assert.match(publish, /const nativeIdsValid = x\.supplier_code !== "cj"/);
  assert.match(publish, /const unitCostKnown = Number\.isFinite\(Number\(x\.unit_cost\)\) && Number\(x\.unit_cost\) > 0/);
  assert.match(publish, /const shippingKnown = x\.raw_data\?\.shippingKnown === true/);
  assert.match(publish, /x\.raw_data\?\.shippingKnown === undefined && x\.raw_data\?\.shippingEstimated !== true/);
  assert.match(publish, /x\.raw_data\?\.shippingKnown === undefined && x\.raw_data\?\.shippingEstimated !== true/);
  assert.match(publish, /x\.raw_data\?\.shippingKnown === true/);
  assert.match(publish, /Boolean\(x\.supplier_product_id && x\.supplier_variant_id && nativeIdsValid && unitCostKnown && shippingKnown\)/);
});

test("catalog publication requires positive profit, not current stock or tracking readiness", async () => {
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  const pricingStart = core.indexOf("export async function recalculatePrice");
  const pricingEnd = core.indexOf("/** Channel state is independent.", pricingStart);
  const pricing = core.slice(pricingStart, pricingEnd);
  assert.match(pricing, /correctly linked offer with known non-negative costs/);
  assert.doesNotMatch(pricing, /offer\.source_status !== "verified"/);
  assert.doesNotMatch(pricing, /offer\.tracking_supported !== true/);
  assert.doesNotMatch(pricing, /offer\.ship_to !== "JP"/);
  assert.doesNotMatch(pricing, /supplier_offer_verification_stale/);
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publish, /supplier_live_ordering_disabled_until_sandbox_payment_flow_proof/);
  assert.doesNotMatch(publish, /\.gt\("commerce_prices\.expected_profit", 0\)/);
  assert.doesNotMatch(publish, /\.eq\("supplier_offers\.source_status", "verified"\)/);
  assert.doesNotMatch(publish, /\.eq\("supplier_offers\.tracking_supported", true\)/);
  assert.match(publish, /supplier_offer_missing_or_cost_unknown/);
  assert.match(publish, /candidateQuery\.order\("updated_at", \{ ascending: false \}\)\.limit\(1000\)/);
  assert.match(publish, /\.limit\(1000\)/);
});

test("Supabase nested relations normalize object, array, and null shapes", () => {
  const row = { id: "price-1" };
  assert.deepEqual(asRelationRows(row), [row]);
  assert.deepEqual(asRelationRows([row]), [row]);
  assert.deepEqual(asRelationRows(null), []);
  assert.deepEqual(asRelationRows(undefined), []);
});

test("storefront recovery queue is selected before the broad newest-updated catalog batch", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /commerce_recovery_queue_read_failed/);
  assert.match(publish, /\.eq\("channel", channel\)[\s\S]*?\.or\("status\.eq\.pending,last_error\.like\.supplier_offer_not_fulfillable%/);
  assert.match(publish, /priorityCandidates, \.\.\.\(\(data \?\? \[\]\) as unknown as Candidate\[\]\)/);
  assert.match(publish, /seenCandidateIds\.has\(candidate\.id\)/);
  assert.match(publish, /candidateQuery\.order\("updated_at", \{ ascending: false \}\)\.limit\(1000\)/);
  assert.match(publish, /if \(!variantIds\?\.length\)/, "explicit recovery IDs bypass the broad queue lookup");
});

test("bounded recovery processes only unpublished channel listings", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const baseRoute = await readFile(new URL("../app/api/cron/commerce-publish-base/route.ts", import.meta.url), "utf8");
  const shopifyRoute = await readFile(new URL("../app/api/cron/commerce-publish-shopify/route.ts", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/tracer-clean-commerce-recovery.yml", import.meta.url), "utf8");
  assert.match(publish, /onlyUnpublished = true/);
  assert.match(publish, /sortedCandidates\.filter\(\(candidate\) => \{/);
  assert.match(publish, /return !saleable;/, "recovery rechecks published items whose supplier evidence no longer supports saleability");
  assert.match(publish, /supplier_offer_not_fulfillable/, "new items without fresh supplier stock are not published");
  assert.match(baseRoute, /searchParams\.get\("onlyUnpublished"\) !== "false"/, "BASE cron defaults to unpublished-only unless full refresh is explicitly requested");
  assert.match(shopifyRoute, /searchParams\.get\("onlyUnpublished"\) !== "false"/, "Shopify cron defaults to unpublished-only unless full refresh is explicitly requested");
  assert.match(baseRoute, /Math\.min\(20, Math\.max\(1, Math\.floor\(requested\)\)\)/, "BASE cron caps each run at five listings");
  assert.match(shopifyRoute, /Math\.min\(20, Math\.max\(1, Math\.floor\(requested\)\)\)/, "Shopify cron caps each run at ten listings");
  assert.match(workflow, /commerce-reprice-existing\?limit=25/, "recovery reprices in bounded batches before publication");
  assert.match(workflow, /storefrontSyncRemaining/, "recovery records remaining storefront backlog");
  assert.match(workflow, /commerce-publish-base\?limit=10&onlyUnpublished=true/);
  assert.match(workflow, /commerce-publish-shopify\?limit=10&onlyUnpublished=true/);
});

test("stale listing eligibility uses batched supplier, price, and variant reads", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const start = publish.indexOf("async function unpublishUnfulfillableListings");
  const end = publish.indexOf("export async function syncCommerceListings", start);
  const audit = publish.slice(start, end);
  assert.match(audit, /Promise\.all\(\[/);
  assert.match(audit, /from\("commerce_prices"\)[\s\S]*?\.in\("variant_id", variantIds\)/);
  assert.match(audit, /from\("supplier_offers"\)[\s\S]*?\.in\("variant_id", variantIds\)/);
  assert.match(audit, /from\("commerce_variants"\)[\s\S]*?\.in\("id", variantIds\)/);
  assert.doesNotMatch(audit, /for \(const listing of checkableListings\)[\s\S]*?db\.from\("commerce_prices"\)/);
  assert.match(audit, /\.or\("status\.eq\.published,last_error\.like\.supplier_offer_not_fulfillable%/);
  assert.match(audit, /listing\.status === "published" \|\|[\s\S]*?startsWith\("supplier_offer_not_fulfillable:"\)/, "only published rows or explicit supplier-safety errors enter external reconciliation");
  assert.match(audit, /last_error\.like\.supplier_offer_no_longer_fulfillable%/, "previously stopped listings must be reconsidered for recovery");
  assert.match(audit, /startsWith\("supplier_offer_no_longer_fulfillable:"\)/, "previously stopped listings must enter evidence reconciliation again");
  assert.match(audit, /\.order\("last_synced_at", \{ ascending: true, nullsFirst: true \}\)\.limit\(5\)/, "recovery work must remain bounded and rotate by last check");
  assert.match(audit, /\.order\("last_synced_at", \{ ascending: true, nullsFirst: true \}\)\.limit\(5\)/);
  assert.match(audit, /stale_listing_check_timestamp_failed/);
  assert.match(publish, /markCheckedError/);
});

test("publication matches each JPY profitable price to its own cost-bearing supplier offer", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /asRelationRows\(candidate\.supplier_offers\)/);
  assert.match(publish, /asRelationRows\(candidate\.commerce_prices\)/);
  assert.match(publish, /currentPriceRows = asRelationRows\(candidate\.commerce_prices\)\.sort/);
  assert.match(publish, /const currentCanonicalPrice = currentPriceRows\[0\]/);
  assert.match(publish, /const price = currentCanonicalPrice && currentPriceOffer/);
  assert.match(publish, /Number\(currentCanonicalPrice\.margin_rate\) >= 0\.5/);
  assert.doesNotMatch(publish, /\.eq\("commerce_prices\.currency", "JPY"\)/);
  assert.doesNotMatch(publish, /\.gt\("commerce_prices\.expected_profit", 0\)/);
  assert.doesNotMatch(publish, /\.gte\("commerce_prices\.margin_rate", 0\.5\)/);
  assert.match(publish, /validOffers\.find\(\(candidateOffer\) => String\(candidateOffer\.id\) === currentPriceOfferId\)/);
  assert.doesNotMatch(publish, /candidate\.commerce_prices\.supplier_offer_id/);
});
test("published listings without stock, shipping, or profit are removed and externally verified", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const start = publish.indexOf("async function unpublishUnfulfillableListings");
  const end = publish.indexOf("export async function syncCommerceListings", start);
  const audit = publish.slice(start, end);
  assert.match(publish, /const identityCleanup = await unpublishUnfulfillableListings\(channel, db\)/);
  assert.match(audit, /missingSaleEvidence\(/);
  assert.match(audit, /best\.missing\.length === 0/);
  assert.doesNotMatch(audit, /priceFresh|supplierEvidenceFresh|preflightFresh/);
  assert.match(audit, /Number\(price\.margin_rate\) < 0\.5/);
  assert.match(audit, /stock: 0, visible: false/);
  assert.match(audit, /base_unpublish_readback_mismatch/);
  assert.match(audit, /status: "DRAFT"/);
  assert.match(audit, /shopify_unpublish_readback_mismatch/);
  assert.match(audit, /shopify_inventory_zero_failed/);
  assert.match(audit, /supplier_offer_no_longer_fulfillable:/);
  assert.doesNotMatch(audit, /\.delete\(/);
});
test("patrol readiness and snapshots include canonical commerce tables after legacy reset", async () => {
  const pipeline = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
  const patrol = await readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8");
  assert.match(pipeline, /from\("supplier_offers"\)/);
  assert.match(pipeline, /from\("commerce_prices"\)/);
  assert.match(pipeline, /from\("channel_listings"\)/);
  assert.match(pipeline, /readinessSource: canonicalPublishedCount > 0 \? "clean_commerce" : "legacy"/);
  assert.match(patrol, /publishedCommerceListings/);
  assert.match(patrol, /supplierProcurementOrders/);
});
test("BASE listing URLs resolve from the authenticated shop profile when API edit responses omit links", async () => {
  const base = await readFile(new URL("../lib/channels/base.ts", import.meta.url), "utf8");
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(base, /getBasePublicShopUrl/);
  assert.match(base, /\/users\/me/);
  assert.match(base, /payload\?\.user/);
  assert.match(base, /userRecord\?\.shop_url/);
  assert.match(base, /url\.protocol === "https:" \|\| url\.protocol === "http:"/);
  assert.match(publish, /getBasePublicShopUrl\(\)/);
  assert.match(publish, /resolveBasePublicUrl\(visibleResponse, externalProductId, basePublicShopUrl\)/);
});
test("product dashboard displays the canonical commerce catalog instead of legacy zero counts", async () => {
  const page = await readFile(new URL("../app/products/page.tsx", import.meta.url), "utf8");
  assert.match(page, /from\("commerce_products"\)/);
  assert.match(page, /from\("commerce_variants"\)/);
  assert.match(page, /from\("supplier_offers"\)/);
  assert.match(page, /from\("commerce_prices"\)/);
  assert.match(page, /from\("channel_listings"\)/);
  assert.match(page, /BASE・Shopify 自動販売カタログ/);
  assert.match(page, /旧Intelligenceテーブルの件数とは分けて表示/);
});
test("catalog publication is independent of live fulfillment evidence while procurement rechecks it", async () => {
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(core, /offer\.source_status !== "verified"/);
  assert.match(core, /isCanonicalCjNativeId/);
  assert.match(core, /invalid_cj_native_supplier_ids/);
  assert.match(publish, /isCanonicalCjNativeId/);
  assert.doesNotMatch(core, /offer\.tracking_supported !== true/);
  assert.doesNotMatch(core, /supplier_offer_verification_stale/);
  assert.doesNotMatch(core, /supplier_offer_price_not_fulfillable/);
  assert.match(worker, /offer\.source_status !== "verified"/);
  assert.match(worker, /offer\.tracking_supported !== true/);
  assert.match(worker, /supplier_offer_not_fresh_and_fulfillable/);
  assert.match(worker, /exact_supplier_offer_price_missing_stale_or_unprofitable/);
  assert.doesNotMatch(publish, /\.eq\("supplier_offers\.source_status", "verified"\)/);
  assert.doesNotMatch(publish, /\.eq\("supplier_offers\.tracking_supported", true\)/);
  assert.match(publish, /supplier_offer_missing_or_cost_unknown/);
  assert.match(publish, /createBaseItem\(\{[^}]*stock: storefrontStock/s, "first BASE publication must obey the same inventory cap as updates");
  assert.doesNotMatch(publish, /createBaseItem\(\{[^}]*stock: Number\(offer\.inventory\)/s, "raw supplier inventory must never be exposed to the storefront");
  assert.match(publish, /base_created_item_id_save_failed/);
  assert.match(publish, /Only make the item visible after the external ID and image are saved/);
  assert.doesNotMatch(publish, /createBaseItem\(\{[^}]*visible: true/s, "new BASE items must stay hidden until image setup succeeds");
});

test("paid-order intake stores exact offer identity before procurement and repairs duplicate addresses safely", async () => {
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  const preflight = core.indexOf("Intake persists paid orders even when fulfillment evidence is stale or incomplete");
  const orderWrite = core.indexOf('from("commerce_orders").upsert');
  assert.ok(preflight >= 0 && orderWrite > preflight, "exact supplier offer identity must be resolved before order persistence");
  assert.doesNotMatch(core.slice(preflight, orderWrite), /source_status|tracking_supported|last_checked_at|expected_profit|inventory|ship_to/);
  assert.match(core, /supplier_offer_id: line\.offerId/);
  assert.match(core, /offersById\.get\(line\.offerId\)/);
  assert.match(core, /order_refresh_failed/);
  assert.match(core, /const refreshedAddress = \{ \.\.\.previousAddress \}/);
  assert.match(core, /if \(value !== null && value !== undefined && String\(value\)\.trim\(\) !== ""\) refreshedAddress\[key\] = value/);
  assert.match(core, /status: "pending"/);
});

test("supplier importer never substitutes a search-result product ID for unresolved variant identity", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /const exactVariant = await fetchCJVariantByVid\(variant\.vid\)/);
  assert.match(importer, /function japaneseCommerceTitle/);
  assert.match(importer, /function japaneseVariantSuffix/);
  assert.match(importer, /variantTitleJa: title \+ japaneseVariantSuffix\(exactVariant\.nameEn\)/);
  assert.doesNotMatch(importer, /variantTitleJa: exactVariant\.nameEn \? title \+ "（" \+ exactVariant\.nameEn/);
  assert.match(importer, /exactVariant\.vid !== variant\.vid/);
  assert.match(importer, /canonical_supplier_product_id_unresolved/);
  assert.match(importer, /canonical_supplier_variant_price_unresolved/);
  assert.doesNotMatch(importer, /if \(!supplierProductId\)\s*\{\s*const exactVariant/, "a non-empty parent ID from product search is not proof of the live canonical parent");
  assert.match(importer, /supplierProductId === candidate\.id \? detail : await getCJProductDetail\(supplierProductId\)/);
  assert.match(importer, /supplierVariantId: exactVariant\.vid/);
  assert.match(importer, /"women handbag", "crossbody bag women", "tote bag women", "shoulder bag women", "mini bag women",\s*"beauty tools", "makeup brush cleaner", "makeup organizer",\s*"hair accessories women", "claw clips hair", "satin hair scrunchies", "heatless curling rod",/, "CJ discovery must rotate focused searches across bags, beauty tools and hair accessories");
});

test("CJ supplier source titles produce specific Japanese names and descriptions", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  const copy = await readFile(new URL("../lib/commerce/japanese-copy.mjs", import.meta.url), "utf8");
  for (const title of [
    "ダイヤモンド風アルファベット付きパーティーヘアバンド",
    "柄デザインのレディース斜めがけバッグ",
    "木製ハンドルのフェイスケアブラシ",
    "ペーパー素材の編み込みハンドバッグ",
  ]) assert.ok(importer.includes(title), "missing specific Japanese title: " + title);
  for (const description of [
    "イベントや記念日のヘアアレンジ",
    "コーディネートのアクセントになるレディース斜めがけバッグ",
    "木製ハンドルを採用したフェイスケア用ブラシ",
    "ペーパー素材を編み込んだデザインのハンドバッグ",
  ]) assert.ok(copy.includes(description), "missing grounded Japanese description: " + description);
  assert.match(importer, /metadata: \{ sourceTitle: canonicalDetail\.title, sourceProductType: canonicalDetail\.productType \?\? null \}/);
  assert.match(importer, /sourceVariantKey: exactVariant\.vid/);
});

test("procurement revalidates the exact fresh profitable offer and preserves a created supplier order ID", async () => {
  const worker = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
  assert.match(worker, /supplier_offer_not_fresh_and_fulfillable/);
  assert.match(worker, /exact_supplier_offer_price_missing_stale_or_unprofitable/);
  assert.match(worker, /createdSupplierOrderId/);
  assert.match(worker, /supplier_order_created_but_state_repair_failed_leave_processing/);
  assert.doesNotMatch(worker, /country_code_v2"\)\.toUpperCase\(\) \|\| "JP"/);
});

test("Shopify paid-order polling uses the canonical commerce order and procurement pipeline", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons.find((job) => job.path === "/api/cron/shopify-orders")?.schedule, "*/10 * * * *");
  const route = await readFile(new URL("../app/api/cron/shopify-orders/route.ts", import.meta.url), "utf8");
  const sync = await readFile(new URL("../lib/shopify/sync-orders.ts", import.meta.url), "utf8");
  assert.match(route, /syncPaidShopifyOrders\(25\)/);
  assert.match(route, /canonical_shopify_order_ingestion/);
  assert.doesNotMatch(route, /runAutonomousOrderControl/);
  assert.match(sync, /from\("commerce_orders"\)/);
  assert.match(sync, /from\("channel_listings"\)/);
  assert.match(sync, /from\("commerce_prices"\)/);
  assert.match(sync, /listingBySku/);
  assert.match(sync, /function isTracerManagedSku/);
  assert.match(sync, /sku\.startsWith\("TRC-"\) \|\| sku\.startsWith\("CJ-"\)/);
  assert.match(sync, /shopify_sku_mapping_ambiguous/);
  assert.match(sync, /shopify_canonical_sku_lookup_failed/);
  assert.match(sync, /knownStatus === "procurement_pending"/);
  assert.doesNotMatch(sync, /shopify_shipping_address_incomplete/);
  assert.match(sync, /Keep the paid order even when address fields need repair/);
  assert.match(sync, /ingestPaidOrder\(/);
  assert.match(sync, /canonicalShopifyId\(order\.id, "Order"\)/);
  assert.match(sync, /canonicalShopifyId\(item\.id, "LineItem"\)/);
  assert.doesNotMatch(sync, /from\("shop_orders"\)/);
  assert.doesNotMatch(sync, /from\("shop_order_items"\)/);
});
test("BASE order ingestion requires the true order_item_id for tracking reflection", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
  assert.match(route, /base_order_line_identity_missing/);
  assert.match(route, /externalLineId: String\(item\.order_item_id\)/);
  assert.doesNotMatch(route, /externalLineId: String\(item\.order_item_id \?\? item\.item_id\)/);
});
test("BASE tracking reflection is scheduled after procurement and idempotent per order line", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons.find((job) => job.path === "/api/cron/commerce-base-fulfillment")?.schedule, "14,44 * * * *");
  const route = await readFile(new URL("../app/api/cron/commerce-base-fulfillment/route.ts", import.meta.url), "utf8");
  assert.match(route, /from\("commerce_orders"\)/);
  assert.match(route, /procurement_orders\(id,status,tracking_number/);
  assert.match(route, /tracerBaseFulfillmentGroups/);
  assert.match(route, /updateBaseOrderItemFulfillment/);
});
test("Shopify fulfillment tracking sync runs automatically after procurement", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons.find((job) => job.path === "/api/cron/shopify-fulfillment")?.schedule, "7,37 * * * *");
  const route = await readFile(new URL("../app/api/cron/shopify-fulfillment/route.ts", import.meta.url), "utf8");
  assert.match(route, /syncShopifyFulfillments\(25\)/);
});
test("clean commerce cron schedule preserves canonical routes and the required thirty-minute storefront publishing and five-minute patrol", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const schedules = new Map(config.crons.map((job) => [job.path, job.schedule]));
  assert.equal(schedules.get("/api/cron/commerce-cj-import"), "0,30 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-base"), "*/30 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-shopify"), "*/30 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-base-orders"), "1,31 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-procurement"), "13,43 * * * *");
  assert.equal(schedules.get("/api/cron/shopify-publish"), "*/30 * * * *", "Shopify published-listing reconciliation must run every thirty minutes");
  assert.equal(schedules.get("/api/cron/patrol-ai"), "*/5 * * * *", "the existing patrol must remain enabled every five minutes");
  assert.equal(schedules.has("/api/cron/market-sourcing"), false, "supplier-native pipeline must not schedule marketplace sourcing observation");
  assert.equal(schedules.has("/api/cron/orosy-bulk-import"), false);
  assert.equal(schedules.has("/api/cron/supply-first"), false);
});

test("both channels use the shared capped storefront quantity and Japanese title validation", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /getStorefrontStockCap, toStorefrontStockQuantity/);
  assert.match(publish, /toStorefrontStockQuantity\(\s*supplierSaleable \? Number\(offer\.inventory\) : 0,\s*getStorefrontStockCap\(\),\s*\)/);
  assert.doesNotMatch(publish, /Math\.max\(1, Number\(offer\.inventory\) \|\| 0\)/);
  assert.match(publish, /isJapaneseProductTitle\(title\)/);
  assert.match(publish, /stock: storefrontStock/);
  assert.match(publish, /quantity: storefrontStock/);
});

test("TRACER storefront displays published canonical Shopify listings without enabling local auto-ordering", async () => {
  const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
  const productPage = await readFile(new URL("../app/shop/[slug]/page.tsx", import.meta.url), "utf8");
  assert.match(store, /async function loadCanonicalCommerceListings/);
  assert.match(store, /from\("channel_listings"\)/);
  assert.match(store, /from\("commerce_variants"\)/);
  assert.match(store, /from\("supplier_offers"\)/);
  assert.match(store, /from\("commerce_prices"\)/);
  assert.match(store, /const linkedPairs = validPrices/);
  assert.match(store, /candidate\.supplier_product_id\) && Boolean\(candidate\.supplier_variant_id/);
  assert.match(store, /candidate\.source_status === "verified"/);
  assert.match(store, /candidate\.tracking_supported === true && candidate\.ship_to === "JP"/);
  assert.doesNotMatch(store, /if \(!isCJLiveOrderingEnabled\(\)\) return \[\]/);
  assert.match(store, /orderable: isCJLiveOrderPathReady\(\) && offerFresh/);
  // Only variants customers can buy on Shopify (ACTIVE and on the Online Store) count as stock.
  assert.match(store, /product \{ status onlineStoreUrl \}/);
  assert.match(store, /node\.product\?\.status === "ACTIVE" && Boolean\(node\.product\?\.onlineStoreUrl\)/);
  // Stale supplier checks must not drop published products before offerFresh is evaluated.
  assert.doesNotMatch(store, /\.gte\("last_checked_at", freshAfter\)/);
  assert.match(store, /const canonicalListings = await loadCanonicalCommerceListings\(\)/);
  assert.match(productPage, /shopifyProductUrl/);
  assert.match(productPage, /Shopifyで購入する/);
});

test("CJ importer keeps source titles and localizes handbag subtypes", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  assert.ok(importer.includes('[/women.*handbag|handbag.*women/, "レディースハンドバッグ"]'));
  assert.ok(importer.includes('"メタルバックル付きラウンドバッグ"'));
  assert.ok(importer.includes("metadata: { sourceTitle: canonicalDetail.title, sourceProductType: canonicalDetail.productType ?? null }"));
  assert.ok(core.includes("...(input.metadata ? { metadata: input.metadata } : {})"));
});

test("BASE Japanese address separates municipality from street without inventing a city", async () => {
  assert.deepEqual(splitJapaneseAddress("東京都千代田区丸の内1-1-1", "東京都"), {
    city: "千代田区", address1: "丸の内1-1-1"
  });
  assert.deepEqual(splitJapaneseAddress("横浜市中区山下町2-1", "神奈川県"), {
    city: "横浜市中区", address1: "山下町2-1"
  });
  assert.deepEqual(splitJapaneseAddress("address without municipality", "東京都"), {
    city: "", address1: "address without municipality"
  });
  const baseOrders = await readFile(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
  assert.match(baseOrders, /city: parsedAddress\.city/);
  assert.match(baseOrders, /address1: parsedAddress\.address1/);
});

test("CJ variant suffix coverage includes translated sets and color names", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /20点セット/);
  assert.match(importer, /収納ポーチ付き/);
  assert.match(importer, /アッシュグレー/);
  assert.match(importer, /蛍光グリーン/);
  assert.match(importer, /ローズレッド/);
  assert.ok(importer.includes('[/cyan/, "シアン"]'));
  assert.ok(importer.includes('[/khaki/, "カーキ"]'));
});

test("CJ variant suffixes disambiguate non-color supplier options in Japanese", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /4ピン・No\.5斜めクリップ/);
  assert.match(importer, /numberedColor/);
  assert.match(importer, /パールトート・グラデーション/);
  assert.match(importer, /巾着型ショルダー/);
  assert.ok(importer.includes('[/khaki/, "カーキ"]'));
});

test("CJ importer serializes stock and freight requests to respect the supplier QPS limit", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  const stockCall = importer.indexOf("await fetchCJVariantStock(variant.vid)");
  const freightCall = importer.indexOf("calculateCJFreight(variant.vid", stockCall);
  assert.ok(stockCall >= 0 && freightCall > stockCall, "stock must be awaited before the freight request");
  assert.doesNotMatch(importer, /Promise\.allSettled\(\[\s*fetchCJVariantStock[\s\S]*?calculateCJFreight/s);
});

test("CJ native IDs reject TRACER UUIDs before they enter supplier identity records", async () => {
  assert.equal(isCanonicalCJNativeId("1439910326744256512"), true);
  assert.equal(isCanonicalCJNativeId("0AD546B4-E7F4-42BF-BFF1-A742EF8814E3"), false);
  assert.equal(isCanonicalCJNativeId("3AF9799E-E99E-4088-B408-BD78AF370A32"), false);
  assert.equal(isCanonicalCJNativeId("12345"), false);
  assert.equal(isCanonicalCJNativeId(""), false);
  const client = await readFile(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
  assert.match(client, /!isCanonicalCJNativeId\(id\)/);
  assert.match(client, /CJ variant parent ID is not a canonical native ID/);
});

test("BASE product links never fall back to the generic BASE homepage", async () => {
  assert.equal(
    resolveBasePublicUrl({ item: { item_url: "https://shop.example/items/123" } }, "123", ""),
    "https://shop.example/items/123"
  );
  assert.equal(resolveBasePublicUrl({}, "123", "https://shop.example"), "https://shop.example/items/123");
  assert.equal(resolveBasePublicUrl({}, "123", ""), null);
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /resolveBasePublicUrl\(visibleResponse, externalProductId, basePublicShopUrl\)/);
  assert.doesNotMatch(publish, /publishedUrl = "https:\/\/thebase\.com\//);
});


test("Shopify fulfillment sync iterates the fulfillmentOrders nodes array", async () => {
  const source = await readFile(new URL("../lib/shopify/sync-fulfillments.ts", import.meta.url), "utf8");
  assert.match(source, /data\.order\.fulfillmentOrders\.nodes\s*\.filter\(/);
  assert.doesNotMatch(source, /data\.order\.fulfillmentOrders\s*\.filter\(/);
});
test("Shopify paid webhook is signature-verified, idempotent, and writes canonical commerce orders", async () => {
  const webhook = await readFile(new URL("../app/api/webhooks/shopify/orders-paid/route.ts", import.meta.url), "utf8");
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  assert.match(webhook, /verifyShopifyWebhookHmac/);
  assert.match(webhook, /shopify-webhook-id/);
  assert.match(webhook, /insertError\?\.code === "23505"/);
  assert.match(webhook, /ingestPaidOrder\(/);
  assert.match(webhook, /\.eq\("status", "published"\)/);
  assert.match(webhook, /function isTracerManagedSku/);
  assert.match(webhook, /normalizedSku\.startsWith\("CJ-"\) \? 3 : 4/);
  assert.match(core, /procurement_orders/);
  assert.match(core, /payment_status/);
});

test("BASE order polling only imports confirmed paid orders and maps published canonical listings", async () => {
  const baseOrders = await readFile(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
  assert.match(baseOrders, /function isPaid\(/);
  assert.match(baseOrders, /dispatch_status === "unpaid"/);
  assert.match(baseOrders, /status", "published"/);
  assert.match(baseOrders, /ingestPaidOrder\(/);
  assert.match(baseOrders, /splitJapaneseAddress/);
});

test("procurement submits only paid orders with complete shipping and exact current profitable CJ offer", async () => {
  const worker = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
  assert.match(worker, /order\.payment_status !== "paid"/);
  assert.match(worker, /shippingCountryCode\.toUpperCase\(\) !== "JP"/);
  assert.match(worker, /shippingAddress_or_line_incomplete|shipping_address_or_line_incomplete/);
  assert.match(worker, /offer\.source_status !== "verified"/);
  assert.match(worker, /offer\.inventory\) < input\.quantity/);
  assert.match(worker, /offer\.supplier_product_id !== row\.supplier_product_id/);
  assert.match(worker, /status: "processing"/);
  assert.match(worker, /createdSupplierOrderId/);
  assert.match(worker, /trackingNumber/);
});

test("CJ import rotates bounded batches through every child variant", () => {
  const variants = ["black", "white", "pink", "blue", "green", "red", "beige"];
  const first = selectRotatingVariantBatch(variants, 3, 0);
  const second = selectRotatingVariantBatch(variants, 3, 1);
  const third = selectRotatingVariantBatch(variants, 3, 2);
  assert.deepEqual(first, ["black", "white", "pink"]);
  assert.deepEqual(second, ["blue", "green", "red"]);
  assert.deepEqual(third, ["beige", "black", "white"]);
  assert.equal(new Set([...first, ...second, ...third]).size, 7);
  assert.deepEqual(selectRotatingVariantBatch(variants, 20, 0), variants);
  assert.deepEqual(selectRotatingVariantBatch([], 3, 0), []);
});

test("CJ importer persists exact supplier variant IDs and rotates bounded child-variant batches", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /selectRotatingVariantBatch\(variants, Math\.min\(variantBatchLimit, variantBudgetRemaining\), variantRunSlot\)/);
  assert.ok(importer.includes("const limit = Math.min(10, Math.max(1, Number(url.searchParams.get(\"limit\") || 3)))"));
  assert.ok(importer.includes("const variantBatchLimit = Math.min(6, Math.max(1, Number(url.searchParams.get(\"variantLimit\") || 6)))"));
  assert.match(importer, /let variantBudgetRemaining = variantBatchLimit/);
  assert.match(importer, /if \(variantBudgetRemaining <= 0\) break/);
  assert.match(importer, /Math\.min\(variantBatchLimit, variantBudgetRemaining\)/);
  assert.match(importer, /filter\(Boolean\)\.length > 3/);
  assert.match(importer, /variantsAvailable \+= variants\.length/);
  assert.match(importer, /sourceVariantKey: exactVariant\.vid/);
  assert.match(importer, /sku: exactVariant\.sku/);
  assert.match(importer, /supplierVariantId: exactVariant\.vid/);
});

test("CJ discovery rotates through search pages instead of repeatedly fetching page one", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /const discoveryBucket = Math\.floor\(Date\.now\(\) \/ 600_000\)/);
  assert.match(importer, /url\.searchParams\.get\("page"\) \|\| \(discoveryBucket % 10\) \+ 1/);
  assert.match(importer, /searchCJProducts\(query, \{ page, size: Math\.min\(20, limit \* 2\) \}\)/);
});

test("BASE diagnostics reconcile both legacy and commerce-native channel listings", async () => {
  const diagnostics = await readFile(new URL("../app/api/channels/base/diagnostics/route.ts", import.meta.url), "utf8");
  assert.match(diagnostics, /from\("channel_listings"\)/);
  assert.match(diagnostics, /from\("commerce_variants"\)/);
  assert.match(diagnostics, /from\("commerce_prices"\)/);
  assert.match(diagnostics, /from\("supplier_offers"\)/);
  assert.match(diagnostics, /visibleItemsManagedByCommerce/);
  assert.match(diagnostics, /String\(variant\.source_variant_key\) === String\(offer\.supplier_variant_id\)/);
});

test("BASE reconciliation recognizes commerce-native supplier SKUs without auto-mapping", async () => {
  const reconciliation = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
  assert.match(reconciliation, /from\("channel_listings"\)/);
  assert.match(reconciliation, /from\("commerce_variants"\)/);
  assert.match(reconciliation, /from\("commerce_products"\)/);
  assert.match(reconciliation, /from\("supplier_offers"\)/);
  assert.match(reconciliation, /commercePrices = \(await readIn/);
  assert.match(reconciliation, /calculated_at/);
  assert.match(reconciliation, /if \(!priceByVariant\.has\(variantId\)\)/);
  assert.match(reconciliation, /canonical_selling_price/);
  assert.match(reconciliation, /canonicalSellingPrice/);
  assert.match(reconciliation, /TRACER_LEGACY_COMMERCE_PRICE_READ_FAILED/);
  assert.match(reconciliation, /legacyOffersByVariant\.get\(variantId\)/);
  assert.match(reconciliation, /if \(exactCandidates\.length !== 1\) return listing/);
  assert.match(reconciliation, /exactBaseIdMatches: exactIdListings\.map[\s\S]*?canonicalSellingPrice/);
  assert.match(reconciliation, /const canonicalEnrichedListings = listings\.map/);
  assert.ok(reconciliation.includes("const reconciliationListings = [...canonicalEnrichedListings, ...commerceListingRows]"));
  assert.match(reconciliation, /addSupplierIdentifier\(evidence\?\.sku, listing\)/);
  assert.match(reconciliation, /Exact-title candidates are unverified suggestions only/);
  assert.doesNotMatch(reconciliation, /\.update\(|\.insert\(|\.upsert\(/);
});

test("BASE audit workflow waits for commerce-aware production reconciliation", async () => {
  const route = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/base-product-backup.yml", import.meta.url), "utf8");
  assert.match(route, /commerceChannelListingCount: commerceRows\.length,/);
  assert.match(workflow, /hasOwnProperty\.call\(candidate, "commerceChannelListingCount"\)/);
  assert.match(workflow, /"commerceChannelListingCount": d\.get\("commerceChannelListingCount"\)/);
});

test("BASE live price audit compares live, stored, and latest canonical prices after deployment", async () => {
  const workflow = await readFile(new URL("../.github/workflows/tracer-base-live-price-audit.yml", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
  assert.match(workflow, /api\/admin\/channels\/base\/reconciliation/);
  assert.match(workflow, /workflow_run:[\s\S]*?TRACER Run Supplier-First Recovery/);
  assert.match(workflow, /BASE_AUDIT_PRODUCTION_DEPLOYMENT_NOT_AT_WORKFLOW_SHA/);
  assert.match(workflow, /priceMismatchVsStored/);
  assert.match(workflow, /priceMismatchVsCanonical/);
  assert.match(workflow, /canonicalVsStoredMismatch/);
  assert.match(route, /canonicalSellingPrice/);
  assert.match(route, /exactBaseIdMatches: exactIdListings\.map[\s\S]*?canonicalSellingPrice/);
  assert.match(workflow, /const numericPrice = value =>/);
  assert.match(workflow, /livePrice !== null && canonicalPrice !== null/);
  assert.match(workflow, /numericPrice\(item\.exactBaseIdMatches\?\.\[0\]\?\.canonicalSellingPrice\)/);
});

test("BASE reconciliation matches stable commerce TRC SKUs as well as legacy UUID identifiers", async () => {
  const route = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("|([0-9a-f]{24})"));
  assert.match(route, /addSupplierIdentifier\(channelRow\.external_sku, listing\)/);
  assert.match(route, /stableIdentifierMatch\?\.\[2\] && supplierIdentifierCandidates\.length === 1/);
});

test("BASE audit waits for exact commerce TRC identifier match support", async () => {
  const route = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/base-product-backup.yml", import.meta.url), "utf8");
  assert.match(route, /commerceTrcIdentifierMatchCount: items\.filter/);
  assert.match(workflow, /hasOwnProperty\.call\(candidate, "commerceTrcIdentifierMatchCount"\)/);
  assert.match(workflow, /"commerceTrcIdentifierMatchCount": d\.get\("commerceTrcIdentifierMatchCount"\)/);
});


test("CJ imported products use specific customer-facing Japanese descriptions", async () => {
  assert.match(japaneseCommerceDescription("メタルバックル付きラウンドバッグ"), /メタルバックルをあしらったラウンドバッグ/);
  assert.match(japaneseCommerceDescription("日光で色が変わるアセテート製シャーククリップ"), /日光で色の変化を楽しめるアセテート製/);
  assert.match(japaneseCommerceDescription("メイク用ファンブラシ"), /ファン型のメイクブラシ/);
  assert.doesNotMatch(japaneseCommerceDescription("レディースハンドバッグ"), /仕入先の最新情報に基づき確認してください/);
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /descriptionJa: japaneseCommerceDescription\(title\)/);
  for (const title of [
    "ダイヤモンド風アルファベット付きパーティーヘアバンド",
    "柄デザインのレディース斜めがけバッグ",
    "ウェーブ編みデザインのニットハンドバッグ",
    "フェイスケア・メイクツール40点セット",
  ]) assert.ok(importer.includes(title), "specific source title mapping missing: " + title);
  assert.match(japaneseCommerceDescription("柄デザインのレディース斜めがけバッグ"), /斜めがけバッグ/);
  assert.match(japaneseCommerceDescription("ウェーブ編みデザインのニットハンドバッグ"), /ウェーブ状の編みデザイン/);
  assert.match(japaneseCommerceDescription("大容量 レディースハンドバッグ"), /寸法、素材、開口部、ポケット構成、収納量/);
  assert.doesNotMatch(japaneseCommerceDescription("大容量 レディースハンドバッグ"), /毎日の外出やお出かけに合わせやすいレディースハンドバッグ/);
});


test("Shopify publication adopts an existing TRACER product by exact SKU before creating another handle", async () => {
  const publisher = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publisher, /sku:" \+ sku/);
  assert.match(publisher, /shopify_sku_ambiguous/);
  assert.match(publisher, /candidate\.id\.slice\(0, 8\)/);
  assert.match(publisher, /shopify_legacy_handle_sku_mismatch/);
});

test("failed supplier procurement retries only when no supplier order id exists", async () => {
  const worker = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
  assert.match(worker, /\.eq\("status", "failed"\)/);
  assert.match(worker, /\.is\("external_order_id", null\)/);
  assert.match(worker, /retry_count/);
  assert.match(worker, /retryCount >= 3/);
});

test("CJ import keeps unknown stock and unknown Japan freight excluded", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /cj_import_exclusion/);
  assert.match(importer, /shippingKnown: shipping !== null/);
  assert.match(importer, /shippingEstimated: shippingWasEstimated/);
  assert.match(importer, /japanese_title_unavailable/);
});

test("CJ unknown stock still skips before supplier offer upsert", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  const guard = importer.indexOf("if (stock === null || stock <= 0)");
  const guardBlock = guard >= 0 ? importer.slice(guard, importer.indexOf("const shippingCostForPricing = shipping;", guard)) : "";
  const save = importer.indexOf("const saved = await upsertSupplierOffer", guard);
  assert.ok(guard >= 0 && guardBlock.includes("continue;") && save > guard, "unknown or zero stock must continue before supplier offer upsert");
  assert.ok(importer.includes("shippingCostForPricing = shipping;"));
});


test("CJ import reports stale supplier-evidence retry queue progress", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  for (const field of [
    "verifiedOffersStaleEligible",
    "publicationBlockedVariantsSeen",
    "evidenceRetryVariantsQueued",
    "evidenceRetryDeferredByBackoff",
    "staleLegacyListingVariantsQueued",
    "finalEvidenceParentCount",
    "missingPublicationRetriesQueued",
    "newDiscoveryCandidatesQueued",
    "finalCandidateCount",
  ]) {
    assert.match(importer, new RegExp(field + ": 0"));
  }
  assert.match(importer, /last_error\.eq\.japanese_product_title_invalid/, "invalid storefront titles must queue exact CJ evidence refresh so the catalog title can be repaired from supplier detail");
  assert.match(importer, /レディース用ボヘミアン風ワイドヘッドバンド6本セット/, "known CJ headband source title must not fall back to generic Japanese title");
assert.match(importer, /ヘアエクステ用クリップ16個セット（4色）/, "known CJ synthetic hair extension clip title must not fall back to generic Japanese title");
  assert.match(importer, /discoverySearchPagesScanned/);
  assert.match(importer, /while \(newCandidates\.length < 1 && scanPage <= page \+ 5\)/);
  assert.match(importer, /const reserveDiscoverySlot = newCandidates\.length > 0 \? 1 : 0;/, "reserve a discovery slot only when discovery found a new parent");
  assert.match(importer, /\.slice\(0, Math\.max\(0, limit - reserveDiscoverySlot\)\)/, "recovery retries must use the full bounded capacity when discovery is idle");
  assert.ok(importer.includes("stats.verifiedOffersStaleEligible = staleVerifiedForEvidence.length;"));
  assert.ok(importer.includes("stats.evidenceRetryVariantsQueued = evidenceRetryCount;"));
  assert.ok(importer.includes("stats.finalCandidateCount = candidates.length;"));
  assert.match(importer, /publishedShopSupplierIdentities/, "published CJ listings get priority for live evidence refresh");
  assert.match(importer, /!publishedShopListing/, "published CJ listings bypass normal evidence retry backoff");
});

test("scheduled CJ discovery only retries errored variants missing Shopify publication", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /requestedProductIds/);
  assert.match(importer, /const dedupedEvidenceCandidates: ImportCandidate\[\] =/);
  assert.match(importer, /\.eq\("source_status", "error"\)/);
  assert.match(importer, /shopifyVariantIds\.has\(String\(offer\.variant_id\)\)/);
  assert.match(importer, /retryVariantIds/);
  assert.match(importer, /event_type", "cj_import_exclusion"/);
  assert.match(importer, /lastAttemptByIdentity/);
  assert.match(importer, /detail\.recordedAt/);
  assert.match(importer, /\.sort\(\(a, b\) => a\[1\]\.lastAttemptedAt - b\[1\]\.lastAttemptedAt\)/);
  assert.doesNotMatch(importer, /const recoveryPool/);
});

test("scheduled CJ discovery rechecks already-listed variants with missing supplier evidence", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /retryOfferByVariantId/);
  assert.match(importer, /evidenceRetryCandidates/);
  assert.match(importer, /rawData\.nextReverifyAt/);
  assert.match(importer, /reverifyAttempts/);
  assert.match(importer, /retryVariantLimit/);
  assert.match(importer, /return !Number\.isFinite\(checkedAt\) \|\| checkedAt <= evidenceCutoff;/,
    "freshly verified offers must leave the CJ evidence queue until stale again");
  assert.doesNotMatch(importer, /return publicationErrorVariantIds\.has\(String\(offer\.variant_id\)\) \|\|/,
    "publication errors must not force the same recently verified variants through every CJ run");
});

test("BASE publication retries recover exact created IDs and refuse ambiguous stable SKUs", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /fetchBaseItemsSnapshot\(\{ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES \}\)/);
  assert.match(publish, /const state = stateByVariant\.get\(candidate\.id\);\s*return Boolean\(state && !state\.external_product_id\);/);
  assert.match(publish, /if \(!recoveredId && stateByVariant\.has\(candidate\.id\)\)/);
  assert.match(publish, /base_create_recovery_snapshot_unavailable:/);
  assert.match(publish, /base_create_id_persist_failed:/);
  assert.match(publish, /base_identifier_ambiguous:/);
  assert.match(publish, /base_sku_already_mapped_to_other_variant:/);
  assert.doesNotMatch(publish, /external_sku: sku, status: "pending", last_error: null/);
});


test("native CJ product bridge inserts exact identities without a partial-index upsert", async () => {
  const route = await readFile(new URL("../app/api/cron/sales-test-publication/route.ts", import.meta.url), "utf8");
  assert.match(route, /error\?\.code === "23505"/);
  assert.match(route, /native_product_identity_bridge:/);
  assert.doesNotMatch(route, /onConflict: "identity_key"/);
});

test("patrol counts canonical commerce eligibility independently from the legacy listing table", async () => {
  const patrol = await readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8");
  assert.match(patrol, /commerce_variants/);
  assert.match(patrol, /supplier_offers\.source_status", "verified"/);
  assert.match(patrol, /commerce_prices\.expected_profit", 0/);
  assert.match(patrol, /\.gt\("supplier_offers\.unit_cost", 0\)/);
  assert.match(patrol, /\.gt\("supplier_offers\.shipping_cost", 0\)/);
  assert.match(patrol, /Number\(offer\.unit_cost\) > 0 && Number\(offer\.shipping_cost\) > 0/);
  assert.doesNotMatch(patrol, /Number\(offer\.unit_cost\) >= 0/);
  assert.match(patrol, /eligibleForBase: eligibleVariantIds\.size/);
  assert.match(patrol, /newEligibleForBase/);
  assert.match(patrol, /newEligibleForShopify/);
});

test("CJ catalog importer prioritizes stale evidence and unseen parent products with bounded extra pages", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /from\("commerce_products"\)\.select\("source_key"\)\.like\("source_key", "cj:%"\)/);
  assert.match(importer, /Prefer never-imported CJ parents/);
  assert.match(importer, /const queuedDiscoveryCandidates = newCandidates\.slice\(0, discoverySlots\)/);
  assert.match(importer, /candidates = \[\.\.\.dedupedEvidenceCandidates, \.\.\.missingPublicationRetries, \.\.\.queuedDiscoveryCandidates\]/);
  assert.match(importer, /shopifyVariantIds = new Set/);
  assert.match(importer, /retryVariantIds\?\.length/);
  assert.match(importer, /searchParams\.get\("limit"\) \|\| 3/);
  assert.match(importer, /searchParams\.get\("variantLimit"\) \|\| 6/);
  assert.doesNotMatch(importer, /const fallbackCandidates/);
});


test("supply-first active-run lock conflicts are logged as expected skips, not errors", async () => {
  const route = await readFile(new URL("../app/api/cron/supply-first/route.ts", import.meta.url), "utf8");
  assert.match(route, /TRACER SUPPLY-FIRST RUN SKIPPED/);
  assert.match(route, /active_run_lock_conflict/);
  assert.doesNotMatch(route, /console\.error\("\[TRACER SUPPLY-FIRST RUN LOG START FAILED\]"/);
  assert.match(route, /reason: "supply_first_already_running"/);
});

test("scheduled publication skips already-published rows while price reconciliation explicitly refreshes stale prices", async () => {
  const baseRoute = await readFile(new URL("../app/api/cron/commerce-publish-base/route.ts", import.meta.url), "utf8");
  const shopifyRoute = await readFile(new URL("../app/api/cron/commerce-publish-shopify/route.ts", import.meta.url), "utf8");
  const repricer = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.match(baseRoute, /searchParams\.get\("onlyUnpublished"\) !== "false"/);
  assert.match(shopifyRoute, /searchParams\.get\("onlyUnpublished"\) !== "false"/);
  assert.match(repricer, /syncCommerceListings\(channel, batchIds\.length, false, batchIds\)/);
});


test("clean commerce CJ importer respects the shared daily-points cooldown before provider calls", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /isCJQuotaCircuitActive/);
  assert.match(importer, /CJ_QUOTA_CIRCUIT_LOOKUP_FAILED/);
  assert.match(importer, /reason: "cj_daily_api_points_cooldown"/);
  assert.match(importer, /return NextResponse\.json\([\s\S]*?status: 202/);
  assert.ok(importer.indexOf("isCJQuotaCircuitActive(quotaMetadata)") < importer.indexOf("searchCJProducts(query"),
    "the quota circuit must stop CJ calls before search begins");
});


test("clean commerce CJ importer prices linked offers even when cached stock is zero or unknown", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /if \(Number\.isFinite\(shippingCostForPricing\) && shippingCostForPricing >= 0\)\s*\{\s*await recalculatePrice/);
  assert.doesNotMatch(importer, /if \(shipping !== null && shipping >= 0\)\s*\{\s*await recalculatePrice/);
  const priceGateStart = importer.indexOf("if (Number.isFinite(shippingCostForPricing) && shippingCostForPricing >= 0)");
  const priceGateEnd = importer.indexOf("} else {", priceGateStart);
  assert.ok(priceGateStart >= 0 && priceGateEnd > priceGateStart, "freight-based price gate must exist");
  const priceGate = importer.slice(priceGateStart, priceGateEnd);
  assert.match(priceGate, /await recalculatePrice/);
  assert.doesNotMatch(priceGate, /stock !== null/, "stock checks for evidence persistence must not gate pricing");
});


test("existing supplier offers are repriced from database evidence without consuming supplier API quota", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  const schedule = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  assert.match(route, /from\("supplier_offers"\)/);
  assert.match(route, /recalculatePrice\(/);
  assert.match(route, /sourceApiCalls: 0/);
  assert.match(route, /\.order\("calculated_at", \{ ascending: false, nullsFirst: false \}\)/, "canonical price rows must be loaded newest first");
  assert.match(route, /if \(priceByVariant\.has\(variantId\)\) continue/, "older price history must not overwrite the newest price for a variant");
  assert.match(route, /aNeedsPrice/);
  assert.match(route, /rawData\.shippingKnown === true/);
  assert.match(route, /skippedUnknownShipping/);
  assert.match(route, /price\.calculated_at[^\n]*offer\.updated_at/);
  const cronEntries = JSON.parse(schedule).crons;
  assert.ok(cronEntries.some((entry) => entry.path === "/api/cron/commerce-reprice-existing" && entry.schedule === "4,34 * * * *"));
  assert.ok(cronEntries.some((entry) => entry.path === "/api/cron/patrol-ai" && entry.schedule === "*/5 * * * *"));
});

test("BASE paid orders never procure a mapped subset when any non-cancelled line is unmapped", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
  assert.match(route, /filter\(\(item\) => item\.status !== "cancelled"\)/);
  assert.match(route, /base_order_line_identity_missing/);
  assert.match(route, /let hasUnmappedLine = false/);
  assert.match(route, /hasUnmappedLine = true/);
  const blockPartial = route.indexOf("if (hasUnmappedLine)");
  const ingest = route.indexOf("await ingestPaidOrder(");
  assert.ok(blockPartial >= 0 && ingest > blockPartial, "an unmapped line must block the entire order before canonical ingestion");
  assert.doesNotMatch(route, /filter\(\(item\) => item\.status !== "cancelled" && item\.item_id !== undefined\)/);
});

test("BASE order polling rotates through older pages while always rescanning the newest page", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
  assert.match(route, /listBaseOrders\(\{ startOrdered, endOrdered, limit: BASE_ORDER_PAGE_SIZE, offset: 0 \}\)/);
  assert.match(route, /listBaseOrders\(\{ startOrdered, endOrdered, limit: BASE_ORDER_PAGE_SIZE, offset: scanOffset \}\)/);
  assert.match(route, /orderWindow: \{ startOrdered, endOrdered \}/, "BASE polling must log its explicit order date window");
  assert.match(route, /from\("commerce_events"\)[\s\S]*?BASE_ORDER_SCAN_CURSOR_EVENT/);
  assert.match(route, /detail: \{ offset: nextOffset, pageSize: BASE_ORDER_PAGE_SIZE/);
  assert.match(route, /nextScanOffset: nextOffset/);
  assert.match(route, /new Map\(\[\.\.\.recentSummaries, \.\.\.rotatingSummaries\]/);
  assert.match(route, /base_order_import_error:/);
  assert.match(route, /status: "needs_review"/);
  assert.match(route, /status: "resolved"/);
});


test("canonical order pollers emit privacy-safe invocation and outcome counters", async () => {
  const base = await readFile(new URL("../app/api/cron/commerce-base-orders/route.ts", import.meta.url), "utf8");
  const shopify = await readFile(new URL("../app/api/cron/shopify-orders/route.ts", import.meta.url), "utf8");
  assert.match(base, /TRACER BASE ORDER POLL AUTH REJECTED/);
  assert.match(base, /TRACER BASE ORDER POLL FAILED/);
  assert.match(base, /\[TRACER BASE ORDER POLL\]/);
  assert.match(base, /checked: result\.checked, paid: result\.paid, imported: result\.imported/);
  assert.match(shopify, /TRACER SHOPIFY ORDER POLL AUTH REJECTED/);
  assert.match(shopify, /TRACER SHOPIFY ORDER POLL FAILED/);
  assert.match(shopify, /\[TRACER SHOPIFY ORDER POLL\]/);
  assert.match(shopify, /configured: imported\.configured, fetched: imported\.fetched/);
  assert.match(shopify, /errorCategories: imported\.errors\.map/);
  assert.doesNotMatch(shopify, /console\.info\([^\n]*orderIds/);
});


test("existing commerce prices below 50% margin are automatically repriced", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.match(route, /const targetMarginRate = 0\.5/);
  assert.match(route, /margin_rate,calculated_at/);
  assert.match(route, /Number\(price\.margin_rate\) < targetMarginRate/);
  assert.match(route, /targetMarginRate,/);
  assert.doesNotMatch(route, /targetMarginRate: 0\.2/);
});

 
test("commerce publication cron defaults to batches of twenty and caps explicit requests", async () => {
  const baseRoute = await readFile(new URL("../app/api/cron/commerce-publish-base/route.ts", import.meta.url), "utf8");
  const shopifyRoute = await readFile(new URL("../app/api/cron/commerce-publish-shopify/route.ts", import.meta.url), "utf8");
  for (const route of [baseRoute, shopifyRoute]) {
    assert.match(route, /searchParams\.get\("limit"\) \|\| 20/);
    assert.match(route, /Number\.isFinite\(requested\) \?[^\n]*: 20/);
    assert.match(route, /searchParams\.get\("onlyUnpublished"\) !== "false"/);
  }
  assert.match(baseRoute, /Math\.min\(20, Math\.max\(1, Math\.floor\(requested\)\)\)/);
  assert.match(shopifyRoute, /Math\.min\(20, Math\.max\(1, Math\.floor\(requested\)\)\)/);
});


test("published storefront price reconciliation uses exact variants and bounded retry batches", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(route, /syncCommerceListings/);
  assert.match(route, /storefrontSyncRemaining/);
  assert.match(route, /canonicalPrice !== undefined/);
  assert.match(route, /Number\(row\.selling_price\) !== canonicalPrice/);
  assert.doesNotMatch(route, /needsSync/);
  assert.match(route, /allChannelIds\.slice\(0, 25\)/);
  assert.match(route, /\.select\("variant_id,channel,selling_price,status,last_synced_at,last_error"\)/);
  assert.match(route, /\.order\("last_synced_at", \{ ascending: true, nullsFirst: true \}\)/);
  assert.match(publish, /variantIds\?: string\[\]/);
  assert.match(publish, /candidateQuery\.in\("id", \[\.\.\.new Set\(variantIds\)\]\)/);
  assert.match(publish, /selling_price: Number\(price\.selling_price\)/, "successful storefront sync persists the exact published price");
});


test("storefront price reconciliation emits bounded, privacy-safe completion telemetry", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.match(route, /storefrontSyncComplete/);
  assert.match(route, /&& storefrontSyncComplete;/, "a non-empty storefront backlog must not report ok=true");
  assert.match(route, /\[TRACER STOREFRONT PRICE RECONCILE\]/);
  assert.match(route, /storefrontSyncErrorCount: result\.storefrontSyncErrors\.length/);
  assert.match(route, /storefrontSyncFailureDetails/);
  assert.ok(route.includes("variantId: String(failure.variantId)"));
  assert.ok(route.includes('reason: String(failure.error ?? "storefront_sync_failed")'));
  assert.doesNotMatch(route, /console\.info\([^\n]*(?:customer|orderId|supplierVariantId|accessToken)/i);
});


test("TRACER product detail copy stays generic to the actual product", async () => {
  const page = await readFile(new URL("../app/shop/[slug]/page.tsx", import.meta.url), "utf8");
  assert.match(page, /サイズ・素材・カラーなど、商品ごとの仕様を購入前にご確認ください/);
  assert.match(page, /在庫・配送日数・送料・返品条件は商品や配送先によって異なります/);
  assert.doesNotMatch(page, /iPhone 11・12・13・14シリーズ向け/);
  assert.doesNotMatch(page, /お使いの端末に合うケース/);
});


test("publisher selects the latest canonical price calculation before matching its supplier offer", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /commerce_prices\(supplier_offer_id,calculated_at,currency/, "left join must retain variants without canonical prices for reconciliation");
  assert.doesNotMatch(publish, /commerce_prices!inner\(/, "missing canonical prices must not filter published variants out of reconciliation");
  assert.match(publish, /currentPriceRows = asRelationRows\(candidate\.commerce_prices\)\.sort/);
});

test("unpublish safety checks the exact supplier offer behind the canonical price", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /currentPriceOfferId/);
  assert.match(publish, /const currentCanonicalPrice = currentPriceRows\[0\]/);
  assert.match(publish, /const price = currentCanonicalPrice && currentPriceOffer/);
  assert.match(publish, /allOffers\.find\(\(candidateOffer\) => String\(candidateOffer\.id\) === currentPriceOfferId\)/);
  assert.doesNotMatch(publish, /const rawOffer = offer \?\? allOffers\[0\]/);
  assert.doesNotMatch(publish, /price\?\.supplier_offer_id \?\? currentPriceRows\[0\]/);
});

test("storefront sync reads back real BASE and Shopify prices before reporting success", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /TracerStorefrontPriceReadback/);
  assert.match(publish, /fetchBaseItemsSnapshot\(\{ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES \}\)/);
  assert.match(publish, /storefront_price_readback_mismatch:/);
  assert.match(publish, /storefront_price_readback_failed:/);
  assert.match(publish, /status: "error",[\s\S]*?last_error: mismatch/);
  assert.match(publish, /actual !== item\.expectedPrice/);
});

test("price reconciliation disables unverified listings once without starving stale price sync", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(route, /unverifiedVariantIds/);
  assert.match(route, /last_synced_at,last_error/);
  assert.match(route, /row\.status === "published" && unverifiedVariantIds\.has\(variantId\)/);
  assert.match(route, /startsWith\("supplier_offer_not_fulfillable:"\)/);
  assert.match(route, /synced\.processed \?\? synced\.published/);
  assert.match(publish, /supplierEvidenceUnverified/);
  assert.match(publish, /supplier_offer_not_fulfillable:/);
  assert.match(publish, /shopify_unpublish_failed:/);
  assert.match(publish, /staleListings\.unpublished\+\+/);
});

test("storefront reconciliation also syncs updated Japanese product copy", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.match(route, /commerce_products!inner\(updated_at\)/);
  assert.match(route, /productUpdatedAtByVariant/);
  assert.match(route, /contentNeedsSync/);
});


test("storefront reconciliation prioritizes stale prices and recently changed Japanese copy without unverified-listing churn", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.match(route, /recentCopyCutoff/);
  assert.match(route, /contentNeedsSync/);
  assert.match(route, /row\.status === "published" && unverifiedVariantIds\.has\(variantId\)/);
  assert.match(route, /startsWith\("supplier_offer_not_fulfillable:"\)/);
  assert.match(route, /const priority =/);
});


test("live storefront price audit prioritizes Shopify variant/product IDs before unique SKU fallback", async () => {
  const route = await readFile(new URL("../app/api/admin/commerce/live-price-audit/route.ts", import.meta.url), "utf8");
  assert.match(route, /shopifyByVariantId/);
  assert.match(route, /shopifyByProductId/);
  assert.match(route, /sameShopifyId\(id, recordedVariantId\)/);
  assert.match(route, /matchMethod = "variant_id"/);
  assert.match(route, /product_id_and_sku/);
  assert.match(route, /matchMethod = "sku"/);
  assert.match(route, /ambiguous_variant_id_no_mutation/);
  assert.match(route, /ambiguous_live_sku_no_mutation/);
  assert.match(route, /nodes \{ id sku price inventoryQuantity \}/, "audit must read inventory for each Shopify variant");
  assert.match(route, /matched\.inventoryQuantity <= 0/, "inventory mismatch must use the matched variant, not product total inventory");
});

test("Shopify live reconciliation exports full row-level IDs, SKUs, prices, and unlinked products", async () => {
  const route = await readFile(new URL("../app/api/admin/shopify/reconcile/route.ts", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/tracer-shopify-auth-check.yml", import.meta.url), "utf8");
  assert.match(route, /variants\(first: 100\)/);
  assert.match(route, /pageInfo \{ hasNextPage endCursor \}/);
  assert.match(route, /dbShopifyProductId/);
  assert.match(route, /expectedSku/);
  assert.match(route, /shopifyPrice/);
  assert.match(route, /items: checks/);
  assert.match(route, /unlinkedProducts: shopify\.filter/);
  assert.match(route, /notLinkedInDb: shopify\.filter\(\(n\) => !linkedIds\.has\(tail\(n\.id\)\) && !commerceIds\.has\(tail\(n\.id\)\)\)/);
  assert.match(route, /unlinkedProducts: shopify\.filter\(\(node\) => !linkedIds\.has\(tail\(node\.id\)\) && !commerceIds\.has\(tail\(node\.id\)\)\)/);
  assert.match(route, /shop_listings_scan_incomplete/);
  assert.match(workflow, /SHOPIFY_RECONCILIATION_INCOMPLETE_REFUSING_TO_LABEL_AUDIT_COMPLETE/);
  assert.match(workflow, /cp out\.json shopify-reconcile\.json/);
  assert.match(workflow, /shopify-linked-row-audit\.csv/);
  assert.match(workflow, /shopify-unlinked-products\.csv/);
  assert.match(workflow, /Upload read-only Shopify audit evidence/);
  assert.match(workflow, /workflow_run:[\s\S]*?TRACER Run Supplier-First Recovery/);
  assert.match(workflow, /writesPerformed.*False/);
});


test("CJ freight uses the detailed API when required product logistics fields are available", async () => {
  const client = await readFile(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(client, /freightCalculateTip/);
  assert.match(client, /productProEnSet/);
  assert.match(client, /variant\.variantWeight/);
  assert.match(client, /srcAreaCode: options\.startCountryCode/);
  assert.match(client, /destAreaCode: options\.endCountryCode/);
  assert.match(client, /if \(tipQuote !== null\) return tipQuote/);
  assert.match(client, /CJ FREIGHT TIP INPUT INCOMPLETE/);
  assert.match(client, /tip_input_incomplete:/);
  assert.match(client, /freight_no_quote:rows=/);
  assert.match(importer, /diagnostics\.slice\(0, 8\)/);
  assert.match(client, /Do not silently convert or interpret CNY fields/);
});



test("CJ freight quote misses use labeled estimate only with confirmed stock and never mark freight verified", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.ok(importer.includes('recordSkip("shipping_unconfirmed")'));
  assert.ok(importer.includes('recordCjExclusion(supplierProductId + ":" + exactVariant.vid, "japan_freight_unconfirmed"'));
  assert.ok(importer.includes("const shippingCostForPricing = shipping;"));
  assert.ok(importer.includes("const shippingWasEstimated = shipping === null && stock !== null && stock > 0;"));
  assert.ok(importer.includes("if (shippingWasEstimated) shipping = 7.76;"));
  assert.ok(importer.includes('shippingEstimateSource: "cj_historical_p90_570_offers"'));
  assert.ok(importer.includes("shippingKnown: shipping !== null && !shippingWasEstimated"));
  assert.ok(importer.includes("shippingEstimated: shippingWasEstimated"));
  assert.ok(importer.includes("if (stock === null || stock <= 0)"));
  assert.ok(importer.includes("if (stock !== null && stock > 0 && shipping !== null && !shippingWasEstimated)"));
  const publisher = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const repricer = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.ok(publisher.includes("preflightRawOfferData.shippingEstimated !== true"));
  assert.ok(repricer.includes("rawData.shippingEstimated !== true && ("), "estimated freight must never count as confirmed in the unverified-listing reconciliation gate");
  assert.match(repricer, /const shippingKnown = rawData\.shippingEstimated !== true && \([\s\S]*?rawData\.shippingKnown === true/);
  assert.ok(!repricer.includes("rawData.shippingKnown === true || rawData.shippingEstimated === true"), "estimated freight must not satisfy shipping verification");
  assert.ok(repricer.includes("candidateRaw.shippingEstimated !== true && ("), "estimated freight must not mark a supplier candidate fulfillable");
  assert.ok(!repricer.includes("candidateRaw.shippingKnown === true || candidateRaw.shippingEstimated === true"), "estimated freight must not satisfy candidate readiness");
  assert.ok(importer.includes("targetMarginRate: 0.5"));
});

test("bounded recovery runs one safe repricing batch before dedicated publication", async () => {
  const workflow = await readFile(new URL("../.github/workflows/tracer-clean-commerce-recovery.yml", import.meta.url), "utf8");
  assert.match(workflow, /commerce-reprice-existing\?limit=25/);
  assert.match(workflow, /Price calculation did not complete cleanly; refusing publication/);
  assert.match(workflow, /if data\.get\("error"\) or errors/);
  assert.match(workflow, /commerce-publish-base\?limit=10&onlyUnpublished=true/);
  assert.match(workflow, /commerce-publish-shopify\?limit=10&onlyUnpublished=true/);
  assert.doesNotMatch(workflow, /for pass in \$\(seq 1 10\)/);
  assert.match(workflow, /sys\.exit\(1\)/);
});


test("CJ stale-listing evidence retry accepts canonical numeric IDs", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  const badGuard = 'if (!/^\\\\d{10,22}$/.test(parentId) || !/^\\\\d{10,25}$/.test(variantId)) continue;';
  const goodGuard = 'if (!/^\\d{10,22}$/.test(parentId) || !/^\\d{10,25}$/.test(variantId)) continue;';
  assert.ok(!importer.includes(badGuard), "must not use a double-escaped digit class");
  assert.ok(importer.includes(goodGuard), "must validate canonical numeric CJ IDs");
});

test("legacy BASE price reconciliation updates canonical profit margin using percent units", async () => {
  const route = await readFile(new URL("../app/api/cron/base-legacy-price-reconcile/route.ts", import.meta.url), "utf8");
  assert.match(route, /\.select\("variant_id,supplier_offer_id,selling_price,expected_profit,margin_rate,calculated_at"\)/);
  assert.match(route, /canonicalMarginRate = Number\(price\.margin_rate\)/);
  assert.match(route, /canonical_margin_rate_invalid/);
  assert.match(route, /contribution_margin: Math\.round\(canonicalMarginRate \* 10000\) \/ 100/);
});

test("legacy BASE reconciliation repairs margin-only mismatches without editing the storefront price", async () => {
  const route = await readFile(new URL("../app/api/cron/base-legacy-price-reconcile/route.ts", import.meta.url), "utf8");
  assert.match(route, /Number\(listing\.contribution_margin\) !== canonicalMarginPercent/);
  assert.match(route, /if \(oldPrice !== canonicalPrice\) \{[\s\S]*?await editBaseItem\(/);
  assert.match(route, /contribution_margin: Math\.round\(canonicalMarginRate \* 10000\) \/ 100/);
  assert.match(route, /const batch = mismatches\.slice\(0, limit\)/);
});

test("published listings with no supplier offer enter the safety reconciliation queue", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  assert.match(route, /Published listings without any supplier offer must enter this queue too/);
  assert.match(route, /publishedMissingOfferVariantIds/);
  assert.match(route, /row\.status === "published" && publishedMissingOfferVariantIds\.has\(variantId\)/);
  assert.match(route, /published_supplier_offer_lookup_failed/);
  assert.match(route, /Fail closed on lookup errors/);
});


test("supplier safety errors remain in external unpublish reconciliation after DB status leaves published", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /\.or\("status\.eq\.published,last_error\.like\.supplier_offer_not_fulfillable%,last_error\.like\.supplier_offer_no_longer_fulfillable%,last_error\.like\.supplier_offer_disable_failed%"/, "previously stopped listings must be reconsidered for recovery");
  assert.match(publish, /listing\.status === "published" \|\|[\s\S]*?startsWith\("supplier_offer_not_fulfillable:"\)/);
  assert.match(publish, /base_unpublish_readback_mismatch/);
});


test("invalid generic Japanese titles rotate retry priority without inventing a title", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /if \(!isJapaneseProductTitle\(title\)\) \{[\s\S]*?status: "error",[\s\S]*?last_error: "japanese_product_title_invalid",[\s\S]*?last_synced_at: retryAt,[\s\S]*?continue;/);
});


test("BASE and Shopify publish cron routes fail closed when stale listing cleanup fails", async () => {
  for (const path of [
    "../app/api/cron/commerce-publish-base/route.ts",
    "../app/api/cron/commerce-publish-shopify/route.ts",
  ]) {
    const route = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(route, /result\.failed === 0 && result\.staleListings\.failed === 0/,
      "cleanup failures must be included in the route's ok telemetry");
    assert.match(route, /const failed = result\.failed > 0 \|\| result\.staleListings\.failed > 0/,
      "cleanup failures must produce a non-success HTTP response");
    assert.match(route, /staleListingErrors: result\.staleListings\.errors\.slice\(0, 10\)/,
      "cleanup failure details must be visible in bounded logs");
    assert.match(route, /status: failed \? 207 : 200/);
  }
});

test("Shopify inventory sync retries stale changeFromQuantity conflicts with a fresh read", async () => {
  const admin = await readFile(new URL("../lib/shopify/admin.ts", import.meta.url), "utf8");
  assert.match(admin, /async function setShopifyVariantInventoryAttempt\([\s\S]*?attempt = 0/);
  assert.match(admin, /changeFromQuantity argument no longer matches the persisted quantity[\s\S]*?attempt < 2[\s\S]*?setShopifyVariantInventoryAttempt\(input, attempt \+ 1\)/);
  assert.match(admin, /export async function setShopifyVariantInventory\(input:[\s\S]*?return setShopifyVariantInventoryAttempt\(input\)/);
});



test("CJ evidence recovery uses a bounded adaptive retry cap and four-variant batches", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /const retryVariantLimit = Math\.min\(8, Math\.max\(4, limit \* 2\)\)/);
  assert.match(importer, /group\.variantIds\.slice\(0, 4\)/);
  assert.match(importer, /variantIds\.slice\(0, 4\)/);
});


test("BASE and Shopify publication cron routes process up to 20 candidates per run", async () => {
  const base = await readFile(new URL("../app/api/cron/commerce-publish-base/route.ts", import.meta.url), "utf8");
  const shopify = await readFile(new URL("../app/api/cron/commerce-publish-shopify/route.ts", import.meta.url), "utf8");
  assert.match(base, /searchParams.get\("limit"\) \|\| 20/);
  assert.match(base, /Math.min\(20, Math.max\(1, Math.floor\(requested\)\)\) : 20/);
  assert.match(shopify, /searchParams.get\("limit"\) \|\| 20/);
  assert.match(shopify, /Math.min\(20, Math.max\(1, Math.floor\(requested\)\)\) : 20/);
});


test("read-only commerce status exposes legacy products and exact CJ product-variant identity counts", async () => {
  const route = await readFile(new URL("../app/api/admin/commerce/status/route.ts", import.meta.url), "utf8");
  assert.match(route, /count\(db, "products"\)/);
  assert.match(route, /count\(db, "products", q => q\.like\("identity_key", "cj:product:%:variant:%"\)\)/);
  assert.match(route, /legacyCatalog: \{ products: legacyProducts, nativeCjProductVariantIdentities: legacyCjIdentityProducts \}/);
  assert.match(route, /readOnly: true/);
});


test("read-only commerce status reads all channel listing errors instead of truncating diagnostics at 500 rows", async () => {
  const route = await readFile(new URL("../app/api/admin/commerce/status/route.ts", import.meta.url), "utf8");
  assert.match(route, /readAll\(db, "channel_listings", "channel,variant_id,external_product_id,last_error,last_synced_at,commerce_variants\(sku,title_ja,supplier_offers\(supplier_code,supplier_product_id,supplier_variant_id,source_status,last_checked_at\)\)", "variant_id", q => q\.eq\("status", "error"\)\)/);
  assert.doesNotMatch(route, /from\("channel_listings"\)\.select\("channel,variant_id,external_product_id,last_error,last_synced_at,commerce_variants\(sku,title_ja,supplier_offers\(supplier_code,supplier_product_id,supplier_variant_id,source_status,last_checked_at\)\)"\)\.eq\("status", "error"\)\.order\("variant_id"\)\.limit\(500\)/);
});


test("no-longer-fulfillable supplier listings are included in recovery reconciliation", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /last_error\.like\.supplier_offer_no_longer_fulfillable%/);
  assert.match(publish, /startsWith\("supplier_offer_no_longer_fulfillable:"\)/);
  assert.match(publish, /status: "pending",[\s\S]*?last_error: null/,
    "a recovered listing must re-enter the publication queue");
});


test("storefront publication localizes mixed English product titles and blocks English fallback", async () => {
  const japaneseProduct = await readFile(new URL("../lib/intelligence/japanese-product.ts", import.meta.url), "utf8");
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  for (const phrase of [
    "アイシャドウ用メイクブラシセット",
    "卵型 コンパクトメイクスポンジ",
    "ブライダル用 ネックレス・ピアス・ヘアアクセサリーセット",
    "携帯用メイクブラシ 5本セット",
    "メイクブラシ20本セット",
    "大容量 吊り下げ式メイク収納バッグ",
  ]) assert.ok(japaneseProduct.includes(phrase), "missing Japanese title mapping: " + phrase);
  assert.match(publish, /Storefront titles must be fully localized/);
  assert.match(publish, /!containsEnglishWords\(candidate\.title_ja\)/);
  assert.match(publish, /!containsEnglishWords\(product\.title_ja\)/);
});


test("Shopify retries transient HTTP failures only for read-only GraphQL queries", async () => {
  const admin = await readFile(new URL("../lib/shopify/admin.ts", import.meta.url), "utf8");
  assert.match(admin, /httpReadRetryAttempt = 0/);
  assert.match(admin, /query\.trimStart\(\)\.toLowerCase\(\)\.startsWith\("query"\)/);
  assert.match(admin, /const retryableStatus = response\.status === 429 \|\| \[500, 502, 503, 504\]\.includes\(response\.status\)/);
  assert.match(admin, /if \(isReadOnlyQuery && retryableStatus && httpReadRetryAttempt < 3\)/);
  assert.match(admin, /Never replay a mutation after a 5xx/);
  assert.match(admin, /shopifyGraphQL<T>\(query, variables, throttleRetryAttempt, httpReadRetryAttempt \+ 1\)/);
});

test("storefront deduplicates exact supplier variants without collapsing distinct color/style variants by shared title and image", async () => {
  const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
  assert.match(store, /supplierProductId\?\.trim\(\)/);
  assert.match(store, /supplierVariantId\?\.trim\(\)/);
  assert.match(store, /\["supplier-variant", listing\.supplierName\?\.trim\(\)\.toLowerCase\(\) \?\? "", supplierProductId, supplierVariantId\]/);
  assert.doesNotMatch(store, /const titleKey = listing\.title\.normalize/);
  assert.doesNotMatch(store, /const imageKey = listing\.imageUrl/);
});

test("Shopify existing-product handle collisions retry with a stable product-specific handle without creating duplicates", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /updateWithHandleCollisionRecovery/);
  assert.match(publish, /handle\.\{0,80\}already in use\|already in use\.\{0,80\}handle/i);
  assert.match(publish, /const fallbackHandle = safeSlug\(handlePrefix \+ "-" \+ candidate\.id\.replace\(\/-\/g, ""\) \+ "-p" \+ productSuffix\)/);
  assert.match(publish, /return await updateShopifyProduct\(\{ \.\.\.input, handle: fallbackHandle \}\)/);
  assert.doesNotMatch(publish, /catch \(error\) \{[\s\S]{0,500}createShopifyProduct\(\{ title, descriptionHtml: storefrontDescription, handle: fallbackHandle/);
});

test("BASE image format rejection retries with the existing Shopify CDN image only", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /addBaseImageWithFormatFallback/);
  assert.match(publish, /このファイル形式はご利用できません\|file format/);
  assert.match(publish, /BaseCompatibleProductImage/);
  assert.match(publish, /await addBaseItemImage\(\{ itemId: input\.itemId, imageNo: 1, imageUrl: fallbackUrl \}\)/);
  assert.doesNotMatch(publish, /catch \(error\) \{[\s\S]{0,500}createBaseItem\(\{ title, identifier: sku/);
});
