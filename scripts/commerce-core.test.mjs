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

test("price calculation preserves positive profit after fees and target margin", () => {
  const result = calculateSellingPrice({ unitCostJpy: 2000, shippingCostJpy: 500, feeRate: 0.1, targetMarginRate: 0.5 });
  assert.ok(result.sellingPrice > 2500);
  assert.ok(result.expectedProfit > 0);
  assert.ok(result.marginRate >= 0.5);
});
test("rejects invalid rates", () => {
  assert.throws(() => calculateSellingPrice({ unitCostJpy: 100, shippingCostJpy: 0, feeRate: 1, targetMarginRate: 0.1 }), /invalid_rate/);
});
test("rejects negative costs", () => {
  assert.throws(() => calculateSellingPrice({ unitCostJpy: -1, shippingCostJpy: 0, feeRate: 0.1 }), /invalid_unitCostJpy/);
});

test("storefront publication requires exact supplier identity and evidenced landed costs, not cached stock or tracking", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/products/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(publish, /supplier_live_ordering_disabled_until_sandbox_payment_flow_proof/);
  assert.match(publish, /commerce_prices\.expected_profit", 0/);
  assert.match(publish, /const hasPublishableLinkedOffer = offers\.some/);
  assert.match(publish, /offer\.supplier_product_id && offer\.supplier_variant_id && nativeIdsValid/);
  assert.match(publish, /unitCostKnown/);
  assert.match(publish, /offer\.raw_data\?\.shippingKnown === true/);
  assert.doesNotMatch(publish, /offer\.tracking_supported === true/);
  assert.doesNotMatch(publish, /offer\.source_status === "verified" && nativeIdsValid/);
  assert.match(publish, /const supplierShippingKnown =/);
  assert.match(publish, /const supplierStockKnown =/);
  assert.match(publish, /const supplierSaleable = supplierShippingKnown && supplierStockKnown/);
  assert.doesNotMatch(publish, /Math\.max\(1, Number\(offer\.inventory\) \|\| 0\)/);
  assert.match(publish, /現在、仕入先の日本向け送料を再確認中のため、購入できません。確認が完了次第、販売を再開します。/);
  assert.doesNotMatch(dashboard, /offer\.tracking_supported === true/);
  assert.doesNotMatch(dashboard, /Number\(offer\.inventory\) > 0/);
  assert.match(dashboard, /offer\.raw_data\?\.shippingKnown === true/);
});

test("new storefront candidates require evidenced landed costs and exact supplier identity", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /supplier_offers!inner\([^)]*raw_data/);
  assert.match(publish, /const validOffers = asRelationRows\(candidate\.supplier_offers\)/);
  assert.match(publish, /const nativeIdsValid = x\.supplier_code !== "cj"/);
  assert.match(publish, /const unitCostKnown = Number\.isFinite\(Number\(x\.unit_cost\)\) && Number\(x\.unit_cost\) > 0/);
  assert.match(publish, /const shippingKnown = Number\.isFinite\(Number\(x\.shipping_cost\)\) && Number\(x\.shipping_cost\) > 0/);
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
  assert.match(publish, /\.gt\("commerce_prices\.expected_profit", 0\)/);
  assert.doesNotMatch(publish, /\.eq\("supplier_offers\.source_status", "verified"\)/);
  assert.doesNotMatch(publish, /\.eq\("supplier_offers\.tracking_supported", true\)/);
  assert.match(publish, /supplier_offer_missing_or_cost_unknown/);
  assert.match(publish, /Cover the complete current catalog/);
  assert.match(publish, /\.limit\(1000\)/);
});

test("Supabase nested relations normalize object, array, and null shapes", () => {
  const row = { id: "price-1" };
  assert.deepEqual(asRelationRows(row), [row]);
  assert.deepEqual(asRelationRows([row]), [row]);
  assert.deepEqual(asRelationRows(null), []);
  assert.deepEqual(asRelationRows(undefined), []);
});

test("bounded recovery processes only unpublished channel listings", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  const baseRoute = await readFile(new URL("../app/api/cron/commerce-publish-base/route.ts", import.meta.url), "utf8");
  const shopifyRoute = await readFile(new URL("../app/api/cron/commerce-publish-shopify/route.ts", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/tracer-clean-commerce-recovery.yml", import.meta.url), "utf8");
  assert.match(publish, /onlyUnpublished = true/);
  assert.match(publish, /sortedCandidates\.filter\(\(candidate\) => stateByVariant\.get\(candidate\.id\)\?\.status !== "published"\)/);
  assert.match(baseRoute, /searchParams\.get\("onlyUnpublished"\) !== "false"/, "BASE cron defaults to bounded recovery mode");
  assert.match(shopifyRoute, /searchParams\.get\("onlyUnpublished"\) !== "false"/, "Shopify cron defaults to bounded recovery mode");
  assert.match(baseRoute, /Math\.min\(10, Math\.max\(1, Math\.floor\(requested\)\)\)/, "BASE cron caps each run at 10 listings");
  assert.match(shopifyRoute, /Math\.min\(10, Math\.max\(1, Math\.floor\(requested\)\)\)/, "Shopify cron caps each run at 10 listings");
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
  assert.match(audit, /\.eq\("status", "published"\)/, "already-hidden error rows must not consume the bounded scan");
  assert.match(audit, /\.order\("last_synced_at", \{ ascending: true, nullsFirst: true \}\)\.limit\(5\)/);
  assert.match(audit, /stale_listing_check_timestamp_failed/);
  assert.match(publish, /markCheckedError/);
});

test("publication matches each JPY profitable price to its own cost-bearing supplier offer", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /asRelationRows\(candidate\.supplier_offers\)/);
  assert.match(publish, /asRelationRows\(candidate\.commerce_prices\)/);
  assert.match(publish, /const validOfferIds = new Set\(validOffers\.map\(\(x\) => x\.id\)\)/);
  assert.match(publish, /validOfferIds\.has\(x\.supplier_offer_id\) && x\.currency === "JPY"/);
  assert.match(publish, /validOffers\.find\(\(x\) => x\.id === price\.supplier_offer_id\)/);
  assert.doesNotMatch(publish, /candidate\.commerce_prices\.supplier_offer_id/);
});
test("supplier readiness failures do not automatically unpublish profitable catalog listings", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publish, /const staleListings = await unpublishUnfulfillableListings\(channel, db\)/);
  assert.match(publish, /Do not unpublish profitable catalog items merely because live supplier verification is temporarily unavailable/);
  assert.match(publish, /supplier_offer_no_longer_fulfillable:/);
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
  assert.match(worker, /exact_supplier_offer_price_missing_or_unprofitable/);
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
  assert.match(importer, /const queryOptions = \[\s*"women handbag", "beauty tools", "hair accessories women",\s*\]/, "CJ discovery must prioritize women's bags, beauty tools and hair accessories");
});

test("procurement revalidates the exact fresh profitable offer and preserves a created supplier order ID", async () => {
  const worker = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
  assert.match(worker, /supplier_offer_not_fresh_and_fulfillable/);
  assert.match(worker, /exact_supplier_offer_price_missing_or_unprofitable/);
  assert.match(worker, /createdSupplierOrderId/);
  assert.match(worker, /supplier_order_created_but_state_repair_failed_leave_processing/);
  assert.doesNotMatch(worker, /country_code_v2"\)\.toUpperCase\(\) \|\| "JP"/);
});

test("Shopify paid-order polling uses the canonical commerce order and procurement pipeline", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons.find((job) => job.path === "/api/cron/shopify-orders")?.schedule, "*/5 * * * *");
  const route = await readFile(new URL("../app/api/cron/shopify-orders/route.ts", import.meta.url), "utf8");
  const sync = await readFile(new URL("../lib/shopify/sync-orders.ts", import.meta.url), "utf8");
  assert.match(route, /syncPaidShopifyOrders\(25\)/);
  assert.match(route, /canonical_shopify_order_ingestion/);
  assert.doesNotMatch(route, /runAutonomousOrderControl/);
  assert.match(sync, /from\("commerce_orders"\)/);
  assert.match(sync, /from\("channel_listings"\)/);
  assert.match(sync, /from\("commerce_prices"\)/);
  assert.match(sync, /listingBySku/);
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
  assert.equal(config.crons.find((job) => job.path === "/api/cron/commerce-base-fulfillment")?.schedule, "14,29,44,59 * * * *");
  const route = await readFile(new URL("../app/api/cron/commerce-base-fulfillment/route.ts", import.meta.url), "utf8");
  assert.match(route, /from\("commerce_orders"\)/);
  assert.match(route, /procurement_orders\(id,status,tracking_number/);
  assert.match(route, /tracerBaseFulfillmentGroups/);
  assert.match(route, /updateBaseOrderItemFulfillment/);
});
test("Shopify fulfillment tracking sync runs automatically after procurement", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons.find((job) => job.path === "/api/cron/shopify-fulfillment")?.schedule, "7,22,37,52 * * * *");
  const route = await readFile(new URL("../app/api/cron/shopify-fulfillment/route.ts", import.meta.url), "utf8");
  assert.match(route, /syncShopifyFulfillments\(25\)/);
});
test("clean commerce cron schedule preserves canonical routes and the required five-minute patrol", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const schedules = new Map(config.crons.map((job) => [job.path, job.schedule]));
  assert.equal(schedules.get("/api/cron/commerce-cj-import"), "*/10 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-base"), "10,25,40,55 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-shopify"), "*/15 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-base-orders"), "1,16,31,46 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-procurement"), "13,28,43,58 * * * *");
  assert.equal(schedules.get("/api/cron/patrol-ai"), "*/5 * * * *", "the existing patrol must remain enabled every five minutes");
  assert.equal(schedules.has("/api/cron/market-sourcing"), false);
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
  assert.match(store, /orderable: isCJLiveOrderPathReady\(\)/);
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

test("CJ importer serializes stock and freight requests to respect the supplier QPS limit", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  const stockCall = importer.indexOf("await fetchCJVariantStock(variant.vid)");
  const freightCall = importer.indexOf("await calculateCJFreight(variant.vid, { startCountryCode: \"CN\"");
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
  assert.match(importer, /selectRotatingVariantBatch\(variants, variantBatchLimit, variantRunSlot\)/);
  assert.ok(importer.includes("const limit = Math.min(10, Math.max(1, Number(url.searchParams.get(\"limit\") || 3)))"));
  assert.ok(importer.includes("const variantBatchLimit = Math.min(6, Math.max(1, Number(url.searchParams.get(\"variantLimit\") || 2)))"));
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
  assert.match(reconciliation, /const reconciliationListings = \[\.\.\.listings, \.\.\.commerceListingRows\]/);
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

test("CJ import records exclusion reasons without treating a missing freight quote as a verified offer", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /cj_import_exclusion/);
  assert.match(importer, /japan_freight_unconfirmed/);
  assert.match(importer, /japanese_title_unavailable/);
});

test("CJ transient stock or freight lookup failures do not overwrite previously verified supplier offers", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  const guard = importer.indexOf("if (stock === null || shipping === null)");
  const save = importer.indexOf("const saved = await upsertSupplierOffer", guard);
  assert.ok(guard >= 0 && save > guard, "unknown live evidence must skip before supplier offer upsert");
  assert.match(importer, /Do not overwrite it with inventory=0, shipping=0, or sourceStatus=error on transient API failures/);
});


test("scheduled CJ discovery does not spend quota retrying known errored supplier products", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /requestedProductIds/);
  assert.match(importer, /candidates = newCandidates/);
  assert.doesNotMatch(importer, /\.eq\("source_status", "error"\)/);
  assert.doesNotMatch(importer, /const recoveryPool/);
  assert.doesNotMatch(importer, /failed_offer_recovery_read/);
});

test("BASE publication retries recover exact created IDs and refuse ambiguous stable SKUs", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /fetchBaseItemsSnapshot\(\{ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES \}\)/);
  assert.match(publish, /base_create_id_persist_failed:/);
  assert.match(publish, /base_identifier_ambiguous:/);
  assert.match(publish, /base_sku_already_mapped_to_other_variant:/);
  assert.doesNotMatch(publish, /external_sku: sku, status: "pending", last_error: null/);
});


test("patrol counts canonical commerce eligibility independently from the legacy listing table", async () => {
  const patrol = await readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8");
  assert.match(patrol, /commerce_variants/);
  assert.match(patrol, /supplier_offers\.source_status", "verified"/);
  assert.match(patrol, /commerce_prices\.expected_profit", 0/);
  assert.match(patrol, /eligibleForBase: eligibleVariantIds\.size/);
  assert.match(patrol, /newEligibleForBase/);
  assert.match(patrol, /newEligibleForShopify/);
});

test("CJ catalog importer prioritizes unseen parent products and scans bounded extra pages", async () => {
  const importer = await readFile(new URL("../app/api/cron/commerce-cj-import/route.ts", import.meta.url), "utf8");
  assert.match(importer, /from\("commerce_products"\)\.select\("source_key"\)\.like\("source_key", "cj:%"\)/);
  assert.match(importer, /Prefer never-imported CJ parents/);
  assert.match(importer, /while \(newCandidates\.length < limit && scanPage <= page \+ 2\)/);
  assert.ok(importer.includes("candidates = newCandidates.slice(0, limit)"));
  assert.match(importer, /searchParams\.get\("limit"\) \|\| 3/);
  assert.match(importer, /searchParams\.get\("variantLimit"\) \|\| 2/);
  assert.doesNotMatch(importer, /const fallbackCandidates/);
});


test("supply-first active-run lock conflicts are logged as expected skips, not errors", async () => {
  const route = await readFile(new URL("../app/api/cron/supply-first/route.ts", import.meta.url), "utf8");
  assert.match(route, /TRACER SUPPLY-FIRST RUN SKIPPED/);
  assert.match(route, /active_run_lock_conflict/);
  assert.doesNotMatch(route, /console\.error\("\[TRACER SUPPLY-FIRST RUN LOG START FAILED\]"/);
  assert.match(route, /reason: "supply_first_already_running"/);
});

test("scheduled commerce publication refreshes existing listings by default and allows unpublished-only recovery", async () => {
  const baseRoute = await readFile(new URL("../app/api/cron/commerce-publish-base/route.ts", import.meta.url), "utf8");
  const shopifyRoute = await readFile(new URL("../app/api/cron/commerce-publish-shopify/route.ts", import.meta.url), "utf8");
  assert.match(baseRoute, /searchParams\.get\("onlyUnpublished"\) === "true"/);
  assert.match(shopifyRoute, /searchParams\.get\("onlyUnpublished"\) === "true"/);
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
  assert.match(importer, /if \(shipping !== null && shipping >= 0\)\s*\{\s*await recalculatePrice/);
  assert.doesNotMatch(importer, /if \(stock !== null &&/);
});


test("existing supplier offers are repriced from database evidence without consuming supplier API quota", async () => {
  const route = await readFile(new URL("../app/api/cron/commerce-reprice-existing/route.ts", import.meta.url), "utf8");
  const schedule = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  assert.match(route, /from\("supplier_offers"\)/);
  assert.match(route, /recalculatePrice\(/);
  assert.match(route, /sourceApiCalls: 0/);
  assert.match(route, /aNeedsPrice/);
  assert.match(route, /rawData\.shippingKnown === true/);
  assert.match(route, /skippedUnknownShipping/);
  assert.match(route, /price\.calculated_at[^\n]*offer\.updated_at/);
  const cronEntries = JSON.parse(schedule).crons;
  assert.ok(cronEntries.some((entry) => entry.path === "/api/cron/commerce-reprice-existing" && entry.schedule === "*/10 * * * *"));
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
  assert.match(route, /listBaseOrders\(\{ limit: BASE_ORDER_PAGE_SIZE, offset: 0 \}\)/);
  assert.match(route, /listBaseOrders\(\{ limit: BASE_ORDER_PAGE_SIZE, offset: scanOffset \}\)/);
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
