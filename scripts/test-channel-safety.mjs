import assert from "node:assert/strict";
import { decideInventoryRefreshVisibility, evaluateChannelListingEligibility } from "../lib/market/channel-listing-eligibility.ts";
import { isClosedSupplierFulfillment } from "../lib/procurement/cj-fulfillment-gate.ts";
import { decideCjSupplyWrite } from "../lib/intelligence/cj-supply-write-policy.ts";
import { cjSellabilityBlockReasons } from "../lib/procurement/cj-fulfillment-gate.ts";
import { classifyCreateOrderResult, classifyStoredAttempt } from "../lib/ordering/supplier-attempt-disposition.ts";
import { assessPublicationDownstream } from "../lib/ops/publication-cron-report.ts";
import { probeListingImage } from "../lib/market/probe-listing-image.ts";

const results = [];
function test(name, fn) {
  results.push(name);
  return Promise.resolve()
    .then(fn)
    .then(() => console.log("PASS", name))
    .catch((error) => {
      console.error("FAIL", name, error);
      process.exitCode = 1;
    });
}

function readyListing(overrides = {}) {
  return {
    title: "床用フロアマット",
    description: "玄関に置く床用フロアマットです。サイズと素材は販売ページの仕様を確認してください。",
    imageUrl: "https://cdn.example.test/mat.jpg",
    imageReachable: true,
    sellingPrice: 3980,
    currency: "JPY",
    sourceCost: 1000,
    shippingCost: 300,
    contributionProfit: 800,
    profitCalculable: true,
    currencyMismatch: false,
    inventory: 4,
    inventoryConfirmed: true,
    orderable: true,
    trackingAvailable: true,
    supplierProductId: "pid-1",
    supplierVariantId: "vid-1",
    identityLinked: true,
    identityMethod: "jan",
    identityConfidence: 0.95,
    salesTestPassed: true,
    supplierName: "tracer_internal",
    supplierAdapterRegistered: true,
    ...overrides,
  };
}

await test("channel gate rejects blank ids, non-JPY, non-positive profit, and unfetched images", () => {
  const blank = evaluateChannelListingEligibility(readyListing({ supplierProductId: "  ", supplierVariantId: null }));
  assert.equal(blank.eligible, false);
  assert.ok(blank.reasons.includes("supplier_product_unknown"));
  assert.ok(blank.reasons.includes("supplier_variant_unknown"));
  const dirty = evaluateChannelListingEligibility(readyListing({
    sellingPrice: Number.NaN,
    contributionProfit: 0,
    currency: "USD",
    imageReachable: false,
    inventory: Number.POSITIVE_INFINITY,
  }));
  assert.equal(dirty.eligible, false);
  assert.ok(dirty.reasons.includes("selling_price_invalid"));
  assert.ok(dirty.reasons.includes("profit_not_positive"));
  assert.ok(dirty.reasons.includes("currency_not_jpy"));
  assert.ok(dirty.reasons.includes("image_fetch_failed"));
  assert.ok(dirty.reasons.includes("inventory_zero_or_unknown"));
  const unconfirmed = evaluateChannelListingEligibility(readyListing({ imageReachable: null, inventoryConfirmed: null, trackingAvailable: null }));
  assert.ok(unconfirmed.reasons.includes("image_not_confirmed"));
  assert.ok(unconfirmed.reasons.includes("inventory_unconfirmed"));
  assert.ok(unconfirmed.reasons.includes("tracking_unavailable"));
});

await test("extreme inventory is held for supplier-side recheck without blocking ordinary stock", () => {
  const normal = evaluateChannelListingEligibility(readyListing({ inventory: 1000 }));
  assert.equal(normal.eligible, true);
  const outlier = evaluateChannelListingEligibility(readyListing({ inventory: 14935 }));
  assert.equal(outlier.eligible, false);
  assert.ok(outlier.reasons.includes("inventory_outlier_requires_recheck"));
});

await test("inventory refresh and the storefront cannot restore a closed supplier from stock", () => {
  const restored = decideInventoryRefreshVisibility(readyListing({
    supplierName: "cj",
    supplierAdapterRegistered: false,
    inventory: 12,
    orderable: true,
    trackingAvailable: true,
  }));
  assert.equal(restored.visible, false);
  assert.equal(restored.orderable, false);
  assert.ok(restored.reasons.includes("cj_order_api_not_connected"));
  const blank = decideInventoryRefreshVisibility(readyListing({ supplierVariantId: "   " }));
  assert.equal(blank.visible, false);
  assert.equal(isClosedSupplierFulfillment("CJ Dropshipping"), true);
  assert.equal(isClosedSupplierFulfillment("tracer_internal"), false);
});

await test("CJ remains unsellable while the order path is unconnected", () => {
  const reasons = cjSellabilityBlockReasons({ adapterRegistered: false });
  assert.ok(reasons.includes("cj_supplier_adapter_not_registered"));
  assert.ok(reasons.includes("cj_order_api_not_connected"));
  assert.ok(reasons.includes("cj_payment_confirmation_not_connected"));
  assert.ok(reasons.includes("cj_tracking_sync_not_connected"));
  const listing = evaluateChannelListingEligibility(readyListing({ supplierName: "cj", supplierAdapterRegistered: false }));
  assert.equal(listing.eligible, false);
  assert.ok(listing.reasons.includes("cj_order_api_not_connected"));
});

await test("CJ supply write never becomes a sales offer from stock alone", () => {
  const missing = decideCjSupplyWrite({ supplierProductId: "", supplierVariantId: "  ", identityConfirmed: false, inventory: null, cost: null, shippingCost: null });
  assert.equal(missing.writeSalesOffer, false);
  assert.equal(missing.orderable, false);
  assert.equal(missing.trackingAvailable, false);
  assert.ok(missing.reasons.includes("supplier_product_unknown"));
  assert.ok(missing.reasons.includes("identity_not_confirmed"));
  assert.ok(missing.reasons.includes("inventory_unknown"));
  const stockOnly = decideCjSupplyWrite({
    supplierProductId: "pid",
    supplierVariantId: "vid",
    observedVariantId: "other-vid",
    identityConfirmed: true,
    inventory: 8,
    cost: 10,
    shippingCost: 2,
    trackingObserved: false,
  });
  assert.equal(stockOnly.writeSalesOffer, false);
  assert.equal(stockOnly.orderable, false);
  assert.equal(stockOnly.trackingAvailable, false);
  assert.ok(stockOnly.reasons.includes("supplier_variant_mismatch"));
  assert.ok(stockOnly.reasons.includes("tracking_unavailable"));
});

await test("order results distinguish rejection, ambiguity, and a saved supplier id", () => {
  const rejected = classifyCreateOrderResult({ succeeded: false, supplierOrderId: null, responseCode: "INVENTORY_RACE" });
  assert.equal(rejected.disposition, "explicit_rejection");
  assert.equal(rejected.state, "completed");
  const timeout = classifyCreateOrderResult({ succeeded: false, supplierOrderId: null, responseCode: "TIMEOUT" });
  assert.equal(timeout.disposition, "ambiguous");
  assert.equal(timeout.state, "unknown");
  const missingId = classifyCreateOrderResult({ succeeded: true, supplierOrderId: " ", responseCode: "OK" });
  assert.equal(missingId.disposition, "ambiguous");
  const created = classifyCreateOrderResult({ succeeded: true, supplierOrderId: "so-1", responseCode: "OK" });
  assert.equal(created.disposition, "created");
  assert.equal(classifyStoredAttempt({ state: "unknown", succeeded: false, supplier_order_id: null, response_code: "TIMEOUT" }), "unknown");
  assert.equal(classifyStoredAttempt({ state: "completed", succeeded: false, supplier_order_id: null, response_code: "INVENTORY_RACE" }), "explicit_rejection");
  assert.equal(classifyStoredAttempt({ state: "completed", succeeded: true, supplier_order_id: "so-1", response_code: "OK" }), "dedupe");
});

await test("publication cron counts downstream and ledger failures", () => {
  const failed = assessPublicationDownstream({
    shopify: { failed: [{ listingId: "a", error: "unpublish_failed" }] },
    base: { results: [{ ok: false, error: "oauth" }] },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, 2);
  assert.notEqual(failed.httpStatus, 200);
  const unconfigured = assessPublicationDownstream({ shopify: { configured: false, failed: [] }, base: { results: [] } });
  assert.equal(unconfigured.ok, false);
  assert.ok(unconfigured.reasons.includes("shopify_not_configured"));
  const ledger = assessPublicationDownstream({ shopify: {}, base: { results: [] }, ledgerUpdateFailed: true });
  assert.equal(ledger.ok, false);
  assert.ok(ledger.reasons.includes("cron_ledger_update_failed"));
  const clean = assessPublicationDownstream({ shopify: { failed: 0, errors: [] }, base: { results: [{ ok: false, skipped: true }] } });
  assert.equal(clean.ok, true);
  assert.equal(clean.failed, 0);
});

await test("image probe treats a non-image response as not sellable", async () => {
  const failed = await probeListingImage("https://cdn.example.test/mat.jpg", async () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }));
  assert.equal(failed, false);
  const ok = await probeListingImage("https://cdn.example.test/mat.jpg", async () => new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } }));
  assert.equal(ok, true);
});

function scriptedDb(responder) {
  const calls = [];
  function from(table) {
    const state = { table, op: "select", payload: null, filters: [] };
    const api = {
      select() { return api; },
      insert(payload) { state.op = "insert"; state.payload = payload; return api; },
      update(payload) { state.op = "update"; state.payload = payload; return api; },
      upsert(payload) { state.op = "upsert"; state.payload = payload; return api; },
      eq(column, value) { state.filters.push(["eq", column, value]); return api; },
      neq(column, value) { state.filters.push(["neq", column, value]); return api; },
      or() { return api; },
      order() { return api; },
      limit() { return api; },
      in() { return api; },
      maybeSingle() { return finish(); },
      single() { return finish(); },
      then(resolve, reject) { return finish().then(resolve, reject); },
    };
    function finish() {
      const call = { table: state.table, op: state.op, payload: state.payload, filters: state.filters.slice() };
      calls.push(call);
      return Promise.resolve(responder(call));
    }
    return api;
  }
  return {
    calls,
    from,
    rpc(name, args) {
      const call = { table: "rpc", op: "rpc", name, args, payload: null, filters: [] };
      calls.push(call);
      return Promise.resolve(responder(call));
    },
  };
}

const description = "玄関に置く床用フロアマットです。サイズと素材は販売ページの仕様を確認してください。";

await test("resolveMarketplaceIdentity then persistCjSupplyIntelligence does not save a sales offer", async () => {
  const { resolveMarketplaceIdentity, persistCjSupplyIntelligence } = await import("../lib/intelligence/persist-cj-supply-intelligence.ts");
  const bestseller = { id: "b1", product_id: "p1", jan: "4006381333931", gtin: "4006381333931", ean: null, upc: null, mpn: null, title: "床用フロアマット", brand: null, fetched_at: "2026-10-12T00:00:00.000Z" };
  async function identityFor(rows) {
    const db = scriptedDb(() => ({ data: rows, error: null }));
    return resolveMarketplaceIdentity({
      db,
      supplierProductId: "cj-product",
      supplierVariantId: "cj-variant",
      supplierIdentifiers: { jan: "4006381333931" },
    });
  }
  assert.equal(await identityFor([]), null);
  assert.equal(await identityFor([bestseller, { ...bestseller, id: "b2", product_id: "p2" }]), null);
  const many = Array.from({ length: 51 }, (_, index) => ({ ...bestseller, id: `b${index}`, product_id: `p${index}` }));
  assert.equal(await identityFor(many), null);
  const identity = await identityFor([bestseller]);
  assert.equal(identity?.productId, "p1");
  assert.equal(identity?.method, "jan");

  const db = scriptedDb((call) => {
    if (call.op === "update" && call.table === "supplier_listings" && call.payload?.forceError) return { data: null, error: { message: "forced" } };
    if (call.table === "supplier_listings" && call.op === "select") return { data: { metadata: {} }, error: null };
    if (call.table === "product_intelligence" && call.op === "select") return { data: null, error: null };
    if (call.op === "upsert") return { data: { id: "intel-1" }, error: null };
    return { data: { id: "row-1" }, error: null };
  });
  const persisted = await persistCjSupplyIntelligence({
    productId: "local-product",
    title: "床用フロアマット",
    imageUrl: "https://cdn.example.test/mat.jpg",
    cost: 12,
    shippingCost: 3,
    supplierListingId: "listing-1",
    supplierProductId: "cj-product",
    supplierVariantId: "cj-variant",
    inventory: 5,
    query: "mat",
    fxRate: 150,
    sellingPriceJpy: 3980,
    supplierIdentifiers: { jan: "4006381333931" },
  }, { db, identity, observedVariantId: "cj-variant", trackingObserved: false });
  assert.equal(persisted.orderable, false);
  assert.equal(persisted.offerId, null);
  assert.equal(db.calls.some((call) => call.table === "product_offers"), false);
  const listingUpdate = db.calls.find((call) => call.table === "supplier_listings" && call.op === "update");
  assert.equal(listingUpdate.payload.orderable, false);
  assert.equal(listingUpdate.payload.tracking_available, false);
  assert.equal(listingUpdate.payload.verification_status, "unverified");

  const mismatch = await persistCjSupplyIntelligence({
    productId: "local-product",
    title: "床用フロアマット",
    imageUrl: "https://cdn.example.test/mat.jpg",
    cost: 12,
    shippingCost: 3,
    supplierListingId: "listing-1",
    supplierProductId: "",
    supplierVariantId: "cj-variant",
    inventory: 0,
    query: "mat",
    fxRate: 150,
    sellingPriceJpy: 3980,
  }, { db, identity: null });
  assert.equal(mismatch.offerId, null);
  assert.ok(mismatch.reasons.includes("supplier_product_unknown"));
  assert.ok(mismatch.reasons.includes("identity_not_confirmed"));
  assert.ok(mismatch.reasons.includes("inventory_zero"));
});

function shopifyDb(updateError = null) {
  const calls = [];
  return {
    calls,
    from() {
      const state = { op: "select", payload: null };
      const api = {
        update(payload) { state.op = "update"; state.payload = payload; return api; },
        eq() { return api; },
        or() { return api; },
        select() { return api; },
        or() { return api; },
        maybeSingle() { calls.push({ ...state }); return Promise.resolve({ data: { id: "listing-1" }, error: null }); },
        then(resolve, reject) {
          calls.push({ op: state.op, payload: state.payload });
          return Promise.resolve({ data: null, error: state.op === "update" ? updateError : null }).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

function eligibleShopifyRow(overrides = {}) {
  return {
    id: "listing-1",
    product_id: "p1",
    title: "床用フロアマット",
    description,
    image_url: "https://cdn.example.test/mat.jpg",
    selling_price: 3980,
    currency: "JPY",
    source_currency: "JPY",
    slug: "mat",
    published: true,
    pipeline_stage: "PUBLISHED",
    pipeline_status: "published",
    pipeline_reason: "sales_test_gate_passed",
    selection_reasons: ["sales_test_gate_passed", "inventory_confirmed"],
    supplier_product_id: "pid-1",
    supplier_variant_id: "vid-1",
    identity_method: "jan",
    identity_confidence: 0.95,
    inventory: 4,
    orderable: true,
    tracking_available: true,
    supplier_name: "tracer_internal",
    shipping_cost: 300,
    source_cost: 1000,
    contribution_profit: 800,
    contribution_margin: 0.2,
    shopify_product_id: "gid://shopify/Product/1",
    shopify_variant_id: null,
    shopify_handle: "mat",
    ...overrides,
  };
}

await test("Shopify preview and sync use the same eligibility and refuse an ambiguous variant", async () => {
  const { previewShopifySync, syncListingRows } = await import("../lib/shopify/sync-published-listings.ts");
  const missing = eligibleShopifyRow({ supplier_variant_id: "   ", supplier_name: "cj", orderable: false });
  const previewDb = {
    from() {
      const api = {
        select() { return api; },
        or() { return api; },
        order() { return api; },
        limit() { return Promise.resolve({ data: [missing], error: null }); },
      };
      return api;
    },
  };
  const preview = await previewShopifySync(10, { supabase: previewDb, probeImage: async () => true });
  assert.equal(preview.rows[0].eligible, false);
  assert.ok(preview.rows[0].blockReasons.includes("supplier_variant_unknown"));
  assert.ok(preview.rows[0].blockReasons.includes("cj_order_api_not_connected"));

  const syncDb = shopifyDb();
  let unpublished = 0;
  let inventoryWrites = 0;
  const blocked = await syncListingRows([missing], syncDb, {
    probeImage: async () => true,
    unpublishShopifyProduct: async () => { unpublished += 1; return { published: false }; },
    setShopifyVariantInventory: async () => { inventoryWrites += 1; },
  });
  assert.equal(blocked.synced, 0);
  assert.equal(unpublished, 1);
  assert.equal(inventoryWrites, 0);
  const hide = syncDb.calls.find((call) => call.op === "update" && call.payload?.published === false);
  assert.ok(hide, "successful unpublish updates published");

  const eligible = eligibleShopifyRow();
  const eligiblePreview = await previewShopifySync(10, {
    supabase: {
      from() {
        const api = {
          select() { return api; },
          or() { return api; },
          order() { return api; },
          limit() { return Promise.resolve({ data: [eligible], error: null }); },
        };
        return api;
      },
    },
    probeImage: async () => true,
  });
  assert.equal(eligiblePreview.rows[0].eligible, true);

  // A previously passed item held only for an inventory outlier can recover
  // after fresh supplier stock is normal, even though publication was cleared.
  const recovering = eligibleShopifyRow({
    published: false,
    pipeline_stage: "BLOCKED",
    pipeline_status: "blocked",
    pipeline_reason: "inventory_outlier_requires_recheck",
    inventory: 20,
    orderable: true,
  });
  const recoveryPreview = await previewShopifySync(10, {
    supabase: {
      from() {
        const api = {
          select() { return api; },
          or() { return api; },
          order() { return api; },
          limit() { return Promise.resolve({ data: [recovering], error: null }); },
        };
        return api;
      },
    },
    probeImage: async () => true,
  });
  assert.equal(recoveryPreview.rows[0].eligible, true, JSON.stringify(recoveryPreview.rows[0]));
  const stillBlocked = eligibleShopifyRow({
    published: false,
    pipeline_stage: "BLOCKED",
    pipeline_status: "blocked",
    pipeline_reason: "identity_not_confirmed",
    identity_method: null,
    identity_confidence: null,
  });
  const blockedPreview = await previewShopifySync(10, {
    supabase: {
      from() {
        const api = {
          select() { return api; },
          or() { return api; },
          order() { return api; },
          limit() { return Promise.resolve({ data: [stillBlocked], error: null }); },
        };
        return api;
      },
    },
    probeImage: async () => true,
  });
  assert.equal(blockedPreview.rows[0].eligible, false);
  assert.ok(blockedPreview.rows[0].blockReasons.includes("pipeline_blocked"));

  const ambiguousDb = shopifyDb();
  let inventoryCalls = 0;
  let variantMismatchUnpublishes = 0;
  const product = {
    id: "gid://shopify/Product/1",
    handle: "mat",
    status: "ACTIVE",
    vendor: "TRACER",
    tags: ["TRACER"],
    variants: { nodes: [{ id: "v1", sku: "TRC-vid-1", price: "3980" }, { id: "v2", sku: "TRC-vid-1", price: "3980" }] },
    media: { nodes: [] },
  };
  const ambiguous = await syncListingRows([eligible], ambiguousDb, {
    probeImage: async () => true,
    shopifyGraphQL: async () => ({ product }),
    updateShopifyProduct: async () => product,
    unpublishShopifyProduct: async () => { variantMismatchUnpublishes += 1; return { published: false }; },
    setShopifyVariantInventory: async () => { inventoryCalls += 1; },
  });
  assert.equal(inventoryCalls, 0);
  assert.equal(variantMismatchUnpublishes, 1, "an ambiguous Shopify variant must be unpublished");
  assert.ok(ambiguousDb.calls.some((call) => call.payload?.pipeline_reason === "shopify_variant_mapping_mismatch" && call.payload?.published === false && call.payload?.orderable === false));
  assert.ok(ambiguous.errors.some((error) => error.error === "shopify_variant_sku_ambiguous"));

  const failedDb = shopifyDb({ message: "db down" });
  await syncListingRows([missing], failedDb, {
    probeImage: async () => true,
    unpublishShopifyProduct: async () => ({ published: false }),
  });
  assert.ok(failedDb.calls.some((call) => call.payload?.shopify_sync_status === "reconciliation_required"));
});

await test("BASE hide failure stays retryable and does not claim the listing is unpublished", async () => {
  const { publishPublishedListingsToBase } = await import("../lib/channels/base-publisher.ts");
  const calls = [];
  function db(rows, options = {}) {
    return {
      from() {
        const state = { op: "select", payload: null };
        const api = {
          select() { return api; },
          update(payload) { state.op = "update"; state.payload = payload; return api; },
          eq() { return api; },
          in() { return api; },
          or() { return api; },
          order() { return api; },
          limit() { return api; },
          maybeSingle() { return Promise.resolve({ data: { id: "claimed" }, error: null }); },
          then(resolve, reject) {
            calls.push({ op: state.op, payload: state.payload });
            const failHide = options.failPublishedUpdate && state.op === "update" && state.payload?.published === false;
            const result = state.op === "select" || state.payload === null
              ? { data: rows, error: null }
              : { data: null, error: failHide ? { message: "db down" } : null };
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return api;
      },
    };
  }
  let edits = 0;
  const unknownPrice = await publishPublishedListingsToBase(5, ["listing-1"], {
    forceConfigured: true,
    supabase: db([{ id: "listing-1", published: false, base_item_id: "base-1", selling_price: null, title: "床用フロアマット", description }]),
    editBaseItem: async () => { edits += 1; return { item_id: "base-1" }; },
    probeImage: async () => false,
  });
  assert.equal(edits, 0);
  let staleEdits = 0;
  const staleFailure = await publishPublishedListingsToBase(5, ["listing-stale"], {
    forceConfigured: true,
    supabase: db([{ id: "listing-stale", published: false, base_item_id: "base-stale", selling_price: 3980, title: "床用フロアマット", description }]),
    editBaseItem: async () => { staleEdits += 1; throw new Error("oauth_unauthorized"); },
    probeImage: async () => false,
  });
  assert.equal(staleEdits, 1);
  assert.equal(staleFailure.results.some((result) => result.error === "oauth_unauthorized"), true);
  assert.ok(calls.some((call) => call.payload?.pipeline_reason === "base_hide_failed"));
  assert.equal(calls.some((call) => call.payload?.published === false), false);

  assert.equal(unknownPrice.results[0].error, "base_hide_price_unknown");
  assert.ok(calls.some((call) => call.payload?.pipeline_reason === "base_hide_price_unknown"));
  assert.equal(calls.some((call) => call.payload?.published === false), false);

  calls.length = 0;
  const oauth = await publishPublishedListingsToBase(5, ["listing-2"], {
    forceConfigured: true,
    supabase: db([{
      id: "listing-2",
      published: true,
      base_item_id: "base-2",
      selling_price: 3980,
      title: "床用フロアマット",
      description,
      supplier_name: "cj",
      pipeline_stage: "PUBLISHED",
      pipeline_status: "published",
      pipeline_reason: "sales_test_gate_passed",
      selection_reasons: ["sales_test_gate_passed"],
    }]),
    editBaseItem: async () => { throw new Error("oauth_unauthorized"); },
    probeImage: async () => true,
  });
  assert.equal(oauth.results.some((result) => result.error === "oauth_unauthorized"), true);
  assert.ok(calls.some((call) => call.payload?.pipeline_reason === "base_hide_failed"));
  assert.equal(calls.some((call) => call.payload?.published === false), false);

  calls.length = 0;
  let hideCalls = 0;
  const dbFailed = await publishPublishedListingsToBase(5, ["listing-3"], {
    forceConfigured: true,
    supabase: db([{
      id: "listing-3",
      published: true,
      base_item_id: "base-3",
      selling_price: 3980,
      title: "床用フロアマット",
      description,
      supplier_name: "cj",
      pipeline_stage: "PUBLISHED",
      pipeline_status: "published",
      pipeline_reason: "sales_test_gate_passed",
      selection_reasons: ["sales_test_gate_passed"],
    }], { failPublishedUpdate: true }),
    editBaseItem: async () => { hideCalls += 1; return { item_id: "base-3" }; },
    probeImage: async () => true,
  });
  assert.equal(hideCalls, 1);
  assert.equal(dbFailed.results.some((result) => result.error === "base_hide_succeeded_db_update_failed"), true);
  assert.ok(calls.some((call) => call.payload?.pipeline_reason === "base_hide_succeeded_db_update_failed"));
});

console.log(`${results.length} cases executed`);
