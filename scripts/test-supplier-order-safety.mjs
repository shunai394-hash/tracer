import assert from "node:assert/strict";
import { mock } from "node:test";

process.env.TRACER_TEST_MOCK_SUPABASE = "1";
process.env.SUPPLIER_DRY_RUN = "0";
process.env.TRACER_INTERNAL_LIVE_ORDERING = "1";
process.env.TRACER_INTERNAL_AUTO_ORDERING = "1";

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
      neq() { return api; },
      or() { return api; },
      order() { return api; },
      limit() { return api; },
      in() { return api; },
      maybeSingle() { return finish(); },
      single() { return finish(); },
      then(resolve, reject) { return finish().then(resolve, reject); },
    };
    function finish() {
      const call = { table: state.table, op: state.op, payload: state.payload, name: state.name, filters: state.filters.slice() };
      calls.push(call);
      return Promise.resolve(responder(call));
    }
    return api;
  }
  return {
    calls,
    from,
    rpc(name, args) {
      const call = { table: "rpc", op: "rpc", name, args, payload: null };
      calls.push(call);
      return Promise.resolve(responder(call));
    },
  };
}

const purchaseOrder = {
  id: "po-1",
  supplier_name: "tracer_internal",
  supplier_order_id: null,
  fulfillment_kind: "dropship_customer_order",
  status: "pending_approval",
  shop_order_id: "shop-1",
  product_id: "p1",
  supplier_product_id: "supply-product",
  supplier_variant_id: "supply-variant",
  qty: 1,
  idempotency_key: "dropship:po-1",
  metadata: {},
  human_confirmed_at: null,
};
const shopOrder = {
  id: "shop-1",
  currency: "JPY",
  order_status: "placed",
  shipping_country_code: "JP",
  shipping_province: "東京都",
  shipping_city: "千代田区",
  shipping_line1: "1-1",
  shipping_zip: "1000001",
  customer_name: "テスト顧客",
  customer_phone: "0311112222",
};
const variant = {
  id: "supply-variant",
  supply_product_id: "supply-product",
  active: true,
  orderable: true,
  inventory: 3,
  cost: 1000,
  shipping_cost: 300,
  currency: "JPY",
  internal_supply_products: { title: "床用フロアマット", cost: 1000, shipping_cost: 300, currency: "JPY" },
};

function orderDb(mode) {
  let storedAttempt = null;
  let fulfillment = null;
  let claimed = false;
  if (mode === "unknown_match" || mode === "unknown_absent" || mode === "unknown_multi" || mode === "unknown_mismatch" || mode === "unknown_saved_mismatch" || mode === "unknown_error") {
    storedAttempt = {
      id: "attempt-1",
      state: "unknown",
      succeeded: false,
      response_code: "TIMEOUT",
      supplier_order_id: mode === "unknown_saved_mismatch" ? "saved-ff" : null,
    };
  }
  if (mode === "unknown_match") {
    fulfillment = { id: "ff-existing", status: "reserved", purchase_order_id: "po-1", order_number: "dropship:po-1", created_at: "2026-10-12T00:00:00.000Z" };
  }
  if (mode === "unknown_mismatch") {
    fulfillment = { id: "ff-other", status: "reserved", purchase_order_id: "other-po", order_number: "dropship:po-1", created_at: "2026-10-12T00:00:00.000Z" };
  }
  if (mode === "unknown_saved_mismatch" || mode === "stale_existing") {
    fulfillment = { id: mode === "stale_existing" ? "ff-stale" : "ff-existing", status: "reserved", purchase_order_id: "po-1", order_number: "dropship:po-1", created_at: "2026-10-12T00:00:00.000Z" };
  }
  if (mode === "stale_in_progress" || mode === "fresh_in_progress" || mode === "stale_existing") {
    storedAttempt = {
      id: "attempt-1",
      state: "in_progress",
      succeeded: false,
      supplier_order_id: null,
      response_code: null,
      updated_at: mode === "fresh_in_progress" ? new Date().toISOString() : new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    };
  }
  const db = scriptedDb((call) => {
    if (call.table === "purchase_orders" && call.op === "select") return { data: purchaseOrder, error: null };
    if (call.table === "shop_orders") return { data: shopOrder, error: null };
    if (call.table === "purchase_order_items") return { data: { unit_price: 3980, supplier_variant_id: "supply-variant" }, error: null };
    if (call.table === "kill_switches") return { data: [], error: null };
    if (call.table === "internal_supply_variants") return { data: variant, error: null };
    if (call.table === "supplier_order_attempts" && call.op === "select") return { data: mode === "constraint" ? null : storedAttempt, error: null };
    if (call.table === "supplier_order_attempts" && call.op === "insert") {
      if (mode === "constraint" && claimed) return { data: null, error: { code: "23505", message: "duplicate" } };
      claimed = true;
      return { data: { id: "attempt-1" }, error: null };
    }
    if (call.table === "supplier_order_attempts" && call.op === "update") {
      storedAttempt = { id: "attempt-1", ...(storedAttempt ?? {}), ...call.payload };
      return { data: null, error: null };
    }
    if (call.table === "rpc" && mode === "race") return { data: [], error: null };
    if (call.table === "rpc" && mode === "timeout") return { data: null, error: { message: "statement timeout" } };
    if (call.table === "rpc") return { data: [{ remaining_inventory: 2 }], error: null };
    if (call.table === "internal_fulfillment_orders" && call.op === "insert") {
      fulfillment = { id: "ff-1", status: "reserved", created_at: "2026-10-12T00:00:00.000Z", tracking_number: null };
      return { data: { id: "ff-1" }, error: null };
    }
    if (call.table === "internal_fulfillment_orders" && call.op === "select") {
      if (mode === "unknown_multi") {
        return {
          data: [
            { id: "ff-a", status: "reserved", purchase_order_id: "po-1", order_number: "dropship:po-1" },
            { id: "ff-b", status: "reserved", purchase_order_id: "po-1", order_number: "dropship:po-1" },
          ],
          error: null,
        };
      }
      if (mode === "unknown_error") return { data: null, error: { message: "lookup timeout" } };
      return { data: fulfillment, error: null };
    }
    if (call.table === "tracer_supply_variants") return { data: [], error: null };
    if (call.op === "update" && call.table === "purchase_orders" && mode === "db_fail" && call.payload?.supplier_order_id) {
      return { data: null, error: { message: "purchase order update failed" } };
    }
    if (call.op === "update") return { data: null, error: null };
    return { data: null, error: null };
  });
  return db;
}

let activeDb = null;
mock.module("@/lib/supabase/admin", {
  exports: {
    createSupabaseAdminClient: () => {
      if (!activeDb) throw new Error("test database was not installed");
      return activeDb;
    },
  },
});
const { executeVerifiedSupplierPurchaseOrder, fulfillmentOutcomeAfterPayment } = await import("../lib/ordering/verified-supplier-execution.ts");
const { executeSupplierPurchaseOrder, reconcileUnknownSupplierAttempt } = await import("../lib/ordering/supplier-execution.ts");
const { createDropshipPurchaseOrdersForShopOrder } = await import("../lib/ordering/dropship.ts");

function rpcCount(db) {
  return db.calls.filter((call) => call.op === "rpc").length;
}

activeDb = orderDb("constraint");
const claimed = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(claimed.succeeded, false);
const claimedRpc = rpcCount(activeDb);
const collided = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(collided.succeeded, false);
assert.equal(collided.reason, "supplier_attempt_claim_race_retry");
assert.equal(rpcCount(activeDb), claimedRpc, "unique attempt collision must not place a second order");

activeDb = orderDb("race");
const rejected = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(rejected.succeeded, false);
assert.equal(rejected.supplierOrderId, null);
assert.match(rejected.reason ?? "", /supplier_explicitly_rejected:INVENTORY_RACE/);
const rejectedRpc = rpcCount(activeDb);
const rejectedAgain = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(rejectedAgain.succeeded, false);
assert.match(rejectedAgain.reason ?? "", /supplier_explicitly_rejected:INVENTORY_RACE/);
assert.equal(rpcCount(activeDb), rejectedRpc, "explicit rejection must not place another order");

activeDb = orderDb("timeout");
const unknown = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(unknown.succeeded, false);
assert.equal(unknown.supplierOrderId, null);
assert.match(unknown.reason ?? "", /outcome_unknown/);
const unknownRpc = rpcCount(activeDb);
const unknownAgain = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.match(unknownAgain.reason ?? "", /outcome_unknown|manual_reconciliation/);
assert.equal(rpcCount(activeDb), unknownRpc, "unknown outcome must not place another order");
const unknownAttempt = activeDb.calls.find((call) => call.table === "supplier_order_attempts" && call.op === "update" && call.payload?.response_code === "EXCEPTION");
assert.equal(unknownAttempt.payload.state, "unknown");

activeDb = orderDb("db_fail");
const unsaved = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(unsaved.succeeded, false);
assert.equal(unsaved.supplierOrderId, "ff-1");
assert.equal(unsaved.reason, "supplier_order_created_db_sync_failed");
assert.equal(rpcCount(activeDb), 1);

activeDb = orderDb("created");
const pending = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(pending.succeeded, false);
assert.equal(pending.supplierOrderId, "ff-1");
assert.equal(pending.reason, "supplier_payment_not_confirmed");
const createdRpc = rpcCount(activeDb);
const pendingAgain = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(pendingAgain.supplierOrderId, "ff-1");
assert.equal(pendingAgain.succeeded, false);
assert.equal(rpcCount(activeDb), createdRpc, "payment pending must not place another order");
assert.equal(activeDb.calls.some((call) => call.payload?.supplier_tracking), false);

const direct = await executeSupplierPurchaseOrder("po-1");
assert.equal(direct.attempted, false);
assert.equal(direct.supplierOrderId, "ff-1");

function internalSelects(db) {
  return db.calls.filter((call) => call.table === "internal_fulfillment_orders" && call.op === "select").length;
}

activeDb = orderDb("unknown_match");
const reconciled = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(reconciled.succeeded, false);
assert.equal(reconciled.supplierOrderId, "ff-existing");
assert.equal(reconciled.reason, "supplier_payment_not_confirmed");
assert.equal(rpcCount(activeDb), 0, "reconciling an existing internal order must not create another");
assert.ok(internalSelects(activeDb) >= 1, "unknown attempt must reach the internal fulfillment lookup");
assert.equal(activeDb.calls.some((call) => call.table === "internal_fulfillment_orders" && call.op === "insert"), false);
const reconciledRpc = rpcCount(activeDb);
const reconciledAgain = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(reconciledAgain.succeeded, false);
assert.equal(reconciledAgain.supplierOrderId, "ff-existing");
assert.equal(rpcCount(activeDb), reconciledRpc);

activeDb = orderDb("unknown_absent");
const absent = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(absent.succeeded, false);
assert.equal(absent.supplierOrderId, null);
assert.match(absent.reason ?? "", /supplier_order_absence_unconfirmed_manual_reconciliation_required/);
assert.equal(rpcCount(activeDb), 0);
assert.ok(internalSelects(activeDb) >= 1);

activeDb = orderDb("unknown_multi");
const ambiguous = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(ambiguous.succeeded, false);
assert.equal(ambiguous.supplierOrderId, null);
assert.match(ambiguous.reason ?? "", /supplier_order_reconciliation_ambiguous_manual_reconciliation_required/);
assert.equal(rpcCount(activeDb), 0);

activeDb = orderDb("unknown_mismatch");
const mismatched = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(mismatched.succeeded, false);
assert.equal(mismatched.supplierOrderId, null);
assert.match(mismatched.reason ?? "", /supplier_order_reconciliation_mismatch_manual_reconciliation_required/);
assert.equal(rpcCount(activeDb), 0);

activeDb = orderDb("unknown_saved_mismatch");
const savedMismatch = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(savedMismatch.succeeded, false);
assert.equal(savedMismatch.supplierOrderId, null);
assert.match(savedMismatch.reason ?? "", /supplier_order_reconciliation_mismatch_manual_reconciliation_required/);
assert.equal(rpcCount(activeDb), 0);

activeDb = orderDb("unknown_error");
const lookupFailed = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(lookupFailed.succeeded, false);
assert.equal(lookupFailed.supplierOrderId, null);
assert.match(lookupFailed.reason ?? "", /supplier_order_lookup_failed_manual_reconciliation_required/);
assert.equal(rpcCount(activeDb), 0);

for (const supplierName of ["faire", "dsers", "orosy", "cj", "super delivery"]) {
  let lookups = 0;
  const held = await reconcileUnknownSupplierAttempt({
    supabase: { from() { lookups += 1; throw new Error("lookup must not run"); } },
    supplierName,
    purchaseOrderId: "po-1",
    idempotencyKey: "dropship:item-1",
    savedSupplierOrderId: null,
  });
  assert.equal(lookups, 0, supplierName);
  assert.equal(held.supplierOrderId, null);
  assert.equal(held.reason, "supplier_order_lookup_unsupported_manual_reconciliation_required");
}

const suffixMatch = await reconcileUnknownSupplierAttempt({
  supabase: {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return this; },
        then(resolve) {
          resolve({
            data: [{ id: "ff-suffix", status: "reserved", purchase_order_id: "item-9", order_number: "dropship:item-9" }],
            error: null,
          });
        },
      };
    },
  },
  supplierName: "tracer_internal",
  purchaseOrderId: "real-po",
  idempotencyKey: "dropship:item-9",
  savedSupplierOrderId: null,
});
assert.equal(suffixMatch.supplierOrderId, "ff-suffix");
assert.equal(suffixMatch.reason, "supplier_order_reconciled_payment_pending");

const paidShopOrder = {
  id: "shop-1",
  payment_status: "paid",
  order_status: "placed",
  currency: "JPY",
  shipping_country_code: "JP",
  shipping_province: "東京都",
  shipping_city: "千代田区",
  shipping_line1: "1-1",
  shipping_zip: "1000001",
};
const shopItem = {
  id: "item-1",
  order_id: "shop-1",
  product_id: "p1",
  listing_id: "listing-1",
  qty: 1,
  unit_price: 3980,
  currency: "JPY",
  supplier_product_id: "supply-product",
  supplier_variant_id: "supply-variant",
};
const shopListing = {
  id: "listing-1",
  product_id: "p1",
  supplier_name: "tracer_internal",
  supplier_product_id: "supply-product",
  supplier_variant_id: "supply-variant",
};

function dropshipDb(options = {}) {
  const stats = { inserts: 0, supplierWrites: 0 };
  const pos = new Map();
  let attempts = options.attempts ?? [];
  const paymentStatus = options.paymentStatus ?? "paid";
  const item = { ...shopItem, ...(options.item ?? {}) };
  const db = scriptedDb((call) => {
    const eqValue = (column) => call.filters?.find((filter) => filter[0] === "eq" && filter[1] === column)?.[2];
    if (call.table === "shop_orders") return { data: { ...paidShopOrder, payment_status: paymentStatus }, error: null };
    if (call.table === "shop_order_items") return { data: [item], error: null };
    if (call.table === "shop_listings") return { data: shopListing, error: null };
    if (call.table === "internal_supply_variants") return { data: variant, error: null };
    if (call.table === "kill_switches") return { data: [], error: null };
    if (call.table === "supplier_order_attempts" && call.op === "select") return { data: attempts, error: null };
    if (call.table === "purchase_orders" && call.op === "select") {
      const key = eqValue("idempotency_key");
      return { data: key ? pos.get(key) ?? null : null, error: null };
    }
    if (call.table === "purchase_orders" && call.op === "insert") {
      const key = call.payload.idempotency_key;
      assert.equal(key, `dropship:${item.id}`);
      if (pos.has(key)) return { data: null, error: { code: "23505", message: "duplicate key" } };
      stats.inserts += 1;
      const row = { id: `po-${item.id}`, supplier_order_id: null, status: call.payload.status };
      pos.set(key, row);
      return { data: { id: row.id }, error: null };
    }
    if (call.table === "internal_fulfillment_orders" || call.op === "rpc") {
      stats.supplierWrites += 1;
      return { data: null, error: { message: "supplier write is not allowed from purchase-order intent" } };
    }
    return { data: null, error: null };
  });
  return { db, stats, pos };
}

activeDb = dropshipDb({ paymentStatus: "pending" }).db;
const unpaid = await createDropshipPurchaseOrdersForShopOrder("shop-1");
assert.deepEqual(unpaid.purchaseOrderIds, []);
assert.equal(unpaid.skipped[0].reason, "shop_order_payment_not_confirmed");
assert.equal(activeDb.calls.some((call) => call.table === "purchase_orders" && call.op === "insert"), false);

const sequential = dropshipDb();
activeDb = sequential.db;
const firstIntent = await createDropshipPurchaseOrdersForShopOrder("shop-1");
const secondIntent = await createDropshipPurchaseOrdersForShopOrder("shop-1");
assert.deepEqual(firstIntent.purchaseOrderIds, ["po-item-1"]);
assert.deepEqual(secondIntent.purchaseOrderIds, ["po-item-1"]);
assert.equal(sequential.stats.inserts, 1);
assert.equal(sequential.stats.supplierWrites, 0);
assert.equal(sequential.pos.get("dropship:item-1").id, "po-item-1");

const concurrent = dropshipDb();
activeDb = concurrent.db;
const [left, right] = await Promise.all([
  createDropshipPurchaseOrdersForShopOrder("shop-1"),
  createDropshipPurchaseOrdersForShopOrder("shop-1"),
]);
assert.deepEqual(left.purchaseOrderIds, ["po-item-1"]);
assert.deepEqual(right.purchaseOrderIds, ["po-item-1"]);
assert.equal(concurrent.stats.inserts, 1, "concurrent purchase-order creation must collapse on the idempotency key");
assert.equal(concurrent.stats.supplierWrites, 0);

const otherLine = dropshipDb({ item: { id: "item-2" } });
activeDb = otherLine.db;
const other = await createDropshipPurchaseOrdersForShopOrder("shop-1");
assert.deepEqual(other.purchaseOrderIds, ["po-item-2"]);
assert.equal(otherLine.pos.has("dropship:item-1"), false);

const reusedAttempt = dropshipDb({ attempts: [{ id: "attempt-9", purchase_order_id: "po-from-attempt", state: "unknown", supplier_order_id: null }] });
activeDb = reusedAttempt.db;
const reused = await createDropshipPurchaseOrdersForShopOrder("shop-1");
assert.deepEqual(reused.purchaseOrderIds, ["po-from-attempt"]);
assert.equal(reusedAttempt.stats.inserts, 0);

const unresolvedAttempt = dropshipDb({ attempts: [{ id: "attempt-8", purchase_order_id: null, state: "unknown", supplier_order_id: null }] });
activeDb = unresolvedAttempt.db;
const unresolved = await createDropshipPurchaseOrdersForShopOrder("shop-1");
assert.deepEqual(unresolved.purchaseOrderIds, []);
assert.equal(unresolved.skipped[0].reason, "duplicate_order_unresolved_manual_reconciliation_required");
assert.equal(unresolvedAttempt.stats.inserts, 0);

activeDb = orderDb("constraint");
const [raceA, raceB] = await Promise.all([
  executeVerifiedSupplierPurchaseOrder("po-1"),
  executeVerifiedSupplierPurchaseOrder("po-1"),
]);
assert.equal(raceA.succeeded, false);
assert.equal(raceB.succeeded, false);
assert.equal(rpcCount(activeDb), 1, "parallel execution must create at most one supplier order");
const raceReasons = [raceA.reason, raceB.reason].sort();
assert.ok(raceReasons.includes("supplier_attempt_claim_race_retry"));
assert.equal(raceReasons.filter((reason) => reason === "supplier_payment_not_confirmed").length, 1);

activeDb = orderDb("fresh_in_progress");
const fresh = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(fresh.succeeded, false);
assert.equal(fresh.reason, "supplier_attempt_in_progress");
assert.equal(rpcCount(activeDb), 0);
assert.equal(activeDb.calls.some((call) => call.table === "supplier_order_attempts" && call.op === "update"), false);

activeDb = orderDb("stale_in_progress");
const stale = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(stale.succeeded, false);
assert.equal(stale.supplierOrderId, null);
assert.match(stale.reason ?? "", /supplier_attempt_stale_manual_reconciliation_required/);
assert.match(stale.reason ?? "", /absence_unconfirmed/);
assert.equal(rpcCount(activeDb), 0);
const staleUpdate = activeDb.calls.find((call) => call.table === "supplier_order_attempts" && call.op === "update" && call.payload?.response_code === "STALE_IN_PROGRESS");
assert.equal(staleUpdate.payload.state, "unknown");
assert.equal(staleUpdate.payload.succeeded, false);
const staleAgain = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(staleAgain.succeeded, false);
assert.equal(rpcCount(activeDb), 0, "a stale in-progress attempt must not place another supplier order");

activeDb = orderDb("stale_existing");
const staleFound = await executeVerifiedSupplierPurchaseOrder("po-1");
assert.equal(staleFound.succeeded, false);
assert.equal(staleFound.supplierOrderId, "ff-stale");
assert.equal(staleFound.reason, "supplier_payment_not_confirmed");
assert.equal(rpcCount(activeDb), 0);

const unpaidOutcome = fulfillmentOutcomeAfterPayment({ paymentConfirmed: false, trackingNumber: null, trackingCheckFailed: false });
assert.equal(unpaidOutcome.shipped, false);
assert.equal(unpaidOutcome.status, "supplier_payment_pending");
assert.equal(unpaidOutcome.reason, "supplier_payment_not_confirmed");
const untrackedOutcome = fulfillmentOutcomeAfterPayment({ paymentConfirmed: true, trackingNumber: null, trackingCheckFailed: true });
assert.equal(untrackedOutcome.shipped, false);
assert.equal(untrackedOutcome.status, "placed");
assert.equal(untrackedOutcome.trackingStatus, "pending");
assert.equal(untrackedOutcome.reason, "supplier_payment_confirmed_tracking_pending");
const trackedOutcome = fulfillmentOutcomeAfterPayment({ paymentConfirmed: true, trackingNumber: "TRACK-1", trackingCheckFailed: false });
assert.equal(trackedOutcome.shipped, false);
assert.notEqual(trackedOutcome.status, "shipped");
assert.notEqual(trackedOutcome.status, "delivered");

console.log("PASS supplier order dispositions");
