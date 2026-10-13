import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.TRACER_TEST_MOCK_SUPABASE = "1";

const DESCRIPTION = "床に敷いて使うフロアマットです。室内用の日本製サイズです。";

function sellable(overrides = {}) {
  return {
    id: "listing-1",
    slug: "floor-mat",
    title: "床用フロアマット",
    description: DESCRIPTION,
    image_url: "https://example.test/mat.jpg",
    selling_price: 3980,
    currency: "JPY",
    source_currency: "JPY",
    source_cost: 1000,
    shipping_cost: 300,
    contribution_profit: 2680,
    inventory: 5,
    orderable: true,
    tracking_available: true,
    selection_reasons: ["sales_test_gate_passed", "inventory_confirmed"],
    product_id: "p1",
    supplier_name: "tracer_internal",
    supplier_product_id: "supply-product",
    supplier_variant_id: "supply-variant",
    identity_method: "jan",
    identity_confidence: 0.95,
    published: true,
    pipeline_status: "published",
    pipeline_stage: "PUBLISHED",
    pipeline_reason: "sales_test_gate_passed",
    shopify_product_id: "gid://shopify/Product/1",
    shopify_variant_id: "gid://shopify/ProductVariant/1",
    shopify_sync_status: "synced",
    ...overrides,
  };
}

function client(rows) {
  const calls = [];
  function from(table) {
    const state = { table, op: "select", payload: null };
    const api = {
      select() { return api; },
      insert(payload) { state.op = "insert"; state.payload = payload; return api; },
      update(payload) { state.op = "update"; state.payload = payload; return api; },
      eq() { return api; },
      neq() { return api; },
      not() { return api; },
      gt() { return api; },
      in() { return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { return finish(); },
      single() { return finish(); },
      then(resolve, reject) { return finish().then(resolve, reject); },
    };
    function finish() {
      const call = { table: state.table, op: state.op, payload: state.payload };
      calls.push(call);
      if (state.op === "select") return Promise.resolve({ data: state.table === "shop_listings" ? rows : null, error: null });
      if (state.op === "insert" && state.table === "shop_orders") return Promise.resolve({ data: { id: "order-1" }, error: null });
      return Promise.resolve({ data: null, error: null });
    }
    return api;
  }
  return { calls, from };
}

let active = null;
mock.module("@/lib/supabase/admin", {
  exports: { createSupabaseAdminClient: () => active },
});

const { listPublishedShopListings, placeShopOrder } = await import("../lib/shop/store.ts");

const order = {
  items: [{ listingId: "listing-1", qty: 1 }],
  customerName: "テスト顧客",
  customerEmail: "buyer@example.test",
  customerPhone: "0311112222",
  shippingAddress: "東京都千代田区1-1",
  paymentMethod: "bank_transfer",
};

async function rejected(row, probe = async () => true) {
  active = client([row]);
  const listed = await listPublishedShopListings({
    supabase: active,
    probeImage: probe,
    shopifyConfigured: false,
  });
  assert.equal(listed.length, 0, JSON.stringify(row.supplier_name ?? row.id));
  await assert.rejects(
    () => placeShopOrder(order, { supabase: active, probeImage: probe, shopifyConfigured: false }),
    /listing is not sellable/,
  );
  assert.equal(active.calls.some((call) => call.table === "shop_orders" && call.op === "insert"), false);
}

await rejected(sellable({ source_cost: 5000 }));
await rejected(sellable({ identity_method: null, identity_confidence: null }));
await rejected(sellable({ supplier_product_id: "  " }));
await rejected(sellable({ supplier_variant_id: "" }));
await rejected(sellable({ tracking_available: false }));
await rejected(sellable({ tracking_available: null }));
await rejected(sellable({ currency: "USD" }));
await rejected(sellable({ inventory: 0 }));
await rejected(sellable({ inventory: null }));
await rejected(sellable({ inventory: 14935 }));
await rejected(sellable({ orderable: false }));
await rejected(sellable({ supplier_name: "cj" }));
await rejected(sellable({ supplier_name: "Super Delivery" }));
await rejected(sellable(), async () => false);
await rejected(sellable({
  published: true,
  orderable: true,
  tracking_available: true,
  selection_reasons: ["inventory_confirmed"],
  pipeline_reason: "previously_published",
  pipeline_status: "published",
  pipeline_stage: "PUBLISHED",
}));

active = client([sellable()]);
const visible = await listPublishedShopListings({
  supabase: active,
  probeImage: async () => true,
  shopifyConfigured: true,
  readLiveStock: async () => new Map([["gid://shopify/ProductVariant/1", 0]]),
});
assert.equal(visible.length, 0);
await assert.rejects(
  () => placeShopOrder(order, {
    supabase: active,
    probeImage: async () => true,
    shopifyConfigured: true,
    readLiveStock: async () => new Map([["gid://shopify/ProductVariant/1", 0]]),
  }),
  /live_stock_zero/,
);
assert.equal(active.calls.some((call) => call.table === "shop_orders" && call.op === "insert"), false);

active = client([sellable()]);
const shown = await listPublishedShopListings({
  supabase: active,
  probeImage: async () => true,
  shopifyConfigured: false,
});
assert.equal(shown.length, 1);
assert.equal(shown[0].id, "listing-1");
const placed = await placeShopOrder(order, {
  supabase: active,
  probeImage: async () => true,
  shopifyConfigured: false,
});
assert.equal(placed.orderId, "order-1");
const inserted = active.calls.find((call) => call.table === "shop_orders" && call.op === "insert");
assert.equal(inserted.payload.payment_status, "pending");
assert.equal(inserted.payload.paid_at, null);
assert.equal(inserted.payload.order_status, "pending_payment");

console.log("PASS storefront gate");
