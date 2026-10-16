import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { calculateSellingPrice } from "../lib/commerce/pricing.mjs";

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

test("external storefront publication is blocked until CJ live order/payment proof is enabled", async () => {
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(publish, /cjSupplierAdapter\.capabilities\.liveOrdering/);
  assert.match(publish, /supplier_live_ordering_disabled_until_sandbox_payment_flow_proof/);
  const gateIndex = publish.indexOf("supplier_live_ordering_disabled_until_sandbox_payment_flow_proof");
  const externalWriteIndex = publish.indexOf("await createBaseItem");
  assert.ok(gateIndex >= 0 && externalWriteIndex > gateIndex, "the live-order gate must run before any external storefront write");
});

test("publication and price calculation require fresh verified supplier evidence", async () => {
  const core = await readFile(new URL("../lib/commerce/core.ts", import.meta.url), "utf8");
  const publish = await readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8");
  assert.match(core, /offer\.source_status !== "verified"/);
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
  assert.match(importer, /exactVariant\.vid !== variant\.vid/);
  assert.match(importer, /canonical_supplier_product_id_unresolved/);
  assert.match(importer, /canonical_supplier_variant_price_unresolved/);
  assert.doesNotMatch(importer, /if \(!supplierProductId\)\s*\{\s*const exactVariant/, "a non-empty parent ID from product search is not proof of the live canonical parent");
  assert.match(importer, /supplierProductId === candidate\.id \? detail : await getCJProductDetail\(supplierProductId\)/);
  assert.match(importer, /supplierVariantId: exactVariant\.vid/);
  assert.match(importer, /const queryOptions = \["women handbag", "beauty tools", .*"hair accessories women"\]/, "CJ discovery must rotate across broad product categories including the requested priorities");
});

test("procurement revalidates the exact fresh profitable offer and preserves a created supplier order ID", async () => {
  const worker = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
  assert.match(worker, /supplier_offer_not_fresh_and_fulfillable/);
  assert.match(worker, /exact_supplier_offer_price_missing_or_unprofitable/);
  assert.match(worker, /createdSupplierOrderId/);
  assert.match(worker, /supplier_order_created_but_state_repair_failed_leave_processing/);
  assert.doesNotMatch(worker, /country_code_v2"\)\.toUpperCase\(\) \|\| "JP"/);
});

test("clean commerce cron schedule uses only the new supplier, channel, order, and procurement routes", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  const schedules = new Map(config.crons.map((job) => [job.path, job.schedule]));
  assert.equal(schedules.get("/api/cron/commerce-cj-import"), "*/30 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-base"), "10,25,40,55 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-publish-shopify"), "*/15 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-base-orders"), "1,16,31,46 * * * *");
  assert.equal(schedules.get("/api/cron/commerce-procurement"), "13,28,43,58 * * * *");
  assert.equal(schedules.get("/api/cron/patrol-ai"), "*/5 * * * *");
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
