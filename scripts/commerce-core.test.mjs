import test from "node:test";
import assert from "node:assert/strict";
import { selectRotatingVariantBatch } from "../lib/commerce/variant-batch.ts";
import { readFile } from "node:fs/promises";
import { calculateSellingPrice } from "../lib/commerce/pricing.mjs";
import { splitJapaneseAddress } from "../lib/commerce/japanese-address.mjs";
import { isCanonicalCJNativeId } from "../lib/sources/cj/native-id.mjs";
import { resolveBasePublicUrl } from "../lib/commerce/base-public-url.mjs";

test("price calculation preserves positive profit after fees and target margin", () => {
  const result = calculateSellingPrice({ unitCostJpy: 2000, shippingCostJpy: 500, feeRate: 0.1, targetMarginRate: 0.2 });
  assert.ok(result.sellingPrice > 2500);
  assert.ok(result.expectedProfit > 0);
  assert.ok(result.marginRate >= 0.2);
});
test("rejects invalid rates", () => {
  assert.throws(() => calculateSellingPrice({ unitCostJpy: 100, shippingCostJpy: 0, feeRate: 1, targetMarginRate: 0.1 }), /invalid_rate/);
});
test("rejects negative costs", () => {
  assert.throws(() => calculateSellingPrice({ unitCostJpy: -1, shippingCostJpy: 0, feeRate: 0.1 }), /invalid_unitCostJpy/);
});

test("storefront publication is independent from live supplier purchasing", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publish, /supplier_live_ordering_disabled_until_sandbox_payment_flow_proof/);
  assert.match(publish, /source_status", "verified/);
  assert.match(publish, /expected_profit", 0/);
  assert.match(publish, /tracking_supported", true/);
});

test("catalog publication is independent of live supplier-ordering capability but still requires a verified profitable offer", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publish, /supplier_live_ordering_disabled_until_sandbox_payment_flow_proof/);
  assert.match(publish, /\.eq\("supplier_offers\.source_status", "verified"\)/);
  assert.match(publish, /\.eq\("supplier_offers\.tracking_supported", true\)/);
  assert.match(publish, /supplier_offer_missing_or_out_of_stock/);
});
test("stale published listings are hidden when supplier stock or verification disappears", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /unpublishUnfulfillableListings\(channel, db\)/);
  assert.match(publish, /stock: 0, visible: false/);
  assert.match(publish, /status: "DRAFT"/);
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
test("publication and price calculation require fresh verified supplier evidence", async () => {
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(core, /offer\.source_status !== "verified"/);
  assert.match(core, /isCanonicalCjNativeId/);
  assert.match(core, /invalid_cj_native_supplier_ids/);
  assert.match(publish, /isCanonicalCjNativeId/);
  assert.match(core, /offer\.tracking_supported !== true/);
  assert.match(core, /supplier_offer_verification_stale/);
  assert.match(core, /supplier_offer_price_not_fulfillable/);
  assert.match(core, /const quantityByOffer = new Map<string, number>\(\)/);
  assert.match(core, /quantityByOffer\.get\(line\.offerId\)/);
  assert.match(publish, /\.eq\("supplier_offers\.source_status", "verified"\)/);
  assert.match(publish, /\.eq\("supplier_offers\.tracking_supported", true\)/);
  assert.match(publish, /supplier_offer_missing_or_out_of_stock/);
  assert.match(publish, /createBaseItem\(\{[^}]*stock: storefrontStock/s, "first BASE publication must obey the same inventory cap as updates");
  assert.doesNotMatch(publish, /createBaseItem\(\{[^}]*stock: Number\(offer\.inventory\)/s, "raw supplier inventory must never be exposed to the storefront");
  assert.match(publish, /base_created_item_id_save_failed/);
  assert.match(publish, /Only make the item visible after the external ID and image are saved/);
  assert.doesNotMatch(publish, /createBaseItem\(\{[^}]*visible: true/s, "new BASE items must stay hidden until image setup succeeds");
});

test("paid-order supplier preflight runs before writing the order record", async () => {
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  const preflight = core.indexOf("Validate every supplier offer before persisting a paid order");
  const orderWrite = core.indexOf('from("commerce_orders").upsert');
  assert.ok(preflight >= 0 && orderWrite > preflight, "invalid or stale supplier offers must be rejected before order persistence");
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
  assert.match(importer, /"women handbag"[\s\S]*"phone case"[\s\S]*"pet accessories"[\s\S]*"kitchen storage"[\s\S]*"travel accessories"[\s\S]*"jewelry women"/, "CJ discovery must rotate across fashion, beauty, home, travel, pets and gadgets");
});

test("procurement revalidates the exact fresh profitable offer and preserves a created supplier order ID", async () => {
  const worker = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
  assert.match(worker, /supplier_offer_not_fresh_and_fulfillable/);
  assert.match(worker, /exact_supplier_offer_price_missing_or_unprofitable/);
  assert.match(worker, /createdSupplierOrderId/);
  assert.match(worker, /supplier_order_created_but_state_repair_failed_leave_processing/);
  assert.doesNotMatch(worker, /country_code_v2"\)\.toUpperCase\(\) \|\| "JP"/);
});

test("Shopify fulfillment tracking sync runs automatically after procurement", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons.find((job) => job.path === "/api/cron/shopify-fulfillment")?.schedule, "7,22,37,52 * * * *");
  const route = await readFile(new URL("../app/api/cron/shopify-fulfillment/route.ts", import.meta.url), "utf8");
  assert.match(route, /syncShopifyFulfillments\(25\)/);
});
test("five-minute AI patrol remains scheduled alongside canonical commerce jobs", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons.find((job) => job.path === "/api/cron/patrol-ai")?.schedule, "*/5 * * * *");
});
test("clean commerce cron schedule uses only the new supplier, channel, order, and procurement routes", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const schedules = new Map(config.crons.map((job) => [job.path, job.schedule]));
  assert.equal(schedules.get("/api/cron/commerce-cj-import"), "*/10 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-base"), "10,25,40,55 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-shopify"), "*/15 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-base-orders"), "1,16,31,46 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-procurement"), "13,28,43,58 * * * *");
  assert.equal(schedules.get("/api/cron/patrol-ai"), "*/5 * * * *", "required AI patrol cron must remain enabled");
  assert.equal(schedules.has("/api/cron/market-sourcing"), false);
  assert.equal(schedules.has("/api/cron/orosy-bulk-import"), false);
  assert.equal(schedules.has("/api/cron/supply-first"), false);
});

test("both channels use the shared capped storefront quantity and Japanese title validation", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /getStorefrontStockCap, toStorefrontStockQuantity/);
  assert.match(publish, /toStorefrontStockQuantity\(offer\.inventory, getStorefrontStockCap\(\)\)/);
  assert.match(publish, /isJapaneseProductTitle\(title\)/);
  assert.match(publish, /stock: storefrontStock/);
  assert.match(publish, /quantity: storefrontStock/);
});

test("TRACER storefront includes canonical Shopify listings only when fulfillment is enabled", async () => {
  const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
  assert.match(store, /async function loadCanonicalCommerceListings/);
  assert.match(store, /from\("channel_listings"\)/);
  assert.match(store, /from\("commerce_variants"\)/);
  assert.match(store, /from\("supplier_offers"\)/);
  assert.match(store, /from\("commerce_prices"\)/);
  assert.match(store, /isCJLiveOrderingEnabled\(\)/);
  assert.match(store, /from\("commerce_events"\)/);
  assert.match(store, /const canonicalListings = await loadCanonicalCommerceListings\(\)/);
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
  assert.match(importer, /variantBatchLimit = Math\.min\(6, Math\.max\(1, Number\(url\.searchParams\.get\("variantLimit"\) \|\| 5\)\)\)/);
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
  assert.match(route, /commerceChannelListingCount: commerceRows\?\.length \?\? 0/);
  assert.match(workflow, /hasOwnProperty\.call\(candidate, "commerceChannelListingCount"\)/);
  assert.match(workflow, /"commerceChannelListingCount": d\.get\("commerceChannelListingCount"\)/);
});

test("BASE reconciliation matches stable commerce TRC SKUs as well as legacy UUID identifiers", async () => {
  const route = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("|([0-9a-f]{24})"));
  assert.match(route, /addSupplierIdentifier\(channelRow\.external_sku, listing\)/);
  assert.match(route, /stableIdentifierMatch\?\.\[2\] && supplierIdentifierCandidates\.length === 1/);
});
