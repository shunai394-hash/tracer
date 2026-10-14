import assert from "node:assert/strict";
import { mock } from "node:test";

// CJ order path contract, run with mocked CJ HTTP so no real order or payment
// can happen. Response bodies follow the createOrderV2 / getOrderDetail shapes
// TRACER parses in lib/sources/cj/create-order.ts.
process.env.CJ_API_KEY = process.env.CJ_API_KEY || "ci-cj-key";

const {
  preflightCjOrder,
  selectCjLogistic,
  extractCjPaymentConfirmation,
  classifyCjOrderStatus,
} = await import("../lib/procurement/cj-order-policy.ts");
const { classifyCreateOrderResult } = await import("../lib/ordering/supplier-attempt-disposition.ts");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(name);
    console.log("PASS", name);
  } catch (error) {
    console.error("FAIL", name, error);
    process.exitCode = 1;
  }
}

const orderInput = {
  orderNumber: "dropship:po-1",
  supplierProductId: "cj-pid-1",
  supplierVariantId: "cj-vid-1",
  quantity: 1,
  shippingCountryCode: "JP",
  shippingCountry: "Japan",
  shippingProvince: "東京都",
  shippingCity: "千代田区",
  shippingAddress: "千代田1-1",
  shippingZip: "1000001",
  shippingPhone: "0311112222",
  shippingCustomerName: "テスト顧客",
};

await test("preflight accepts a complete Japanese order and rejects anything incomplete", () => {
  assert.equal(preflightCjOrder(orderInput).valid, true);
  assert.equal(preflightCjOrder({ ...orderInput, shippingZip: " " }).responseCode, "CJ_PREFLIGHT_FIELD_MISSING");
  assert.equal(preflightCjOrder({ ...orderInput, supplierVariantId: "" }).responseCode, "CJ_PREFLIGHT_FIELD_MISSING");
  assert.equal(preflightCjOrder({ ...orderInput, quantity: 0 }).responseCode, "CJ_PREFLIGHT_QUANTITY_INVALID");
  assert.equal(preflightCjOrder({ ...orderInput, quantity: 1.5 }).responseCode, "CJ_PREFLIGHT_QUANTITY_INVALID");
  assert.equal(preflightCjOrder({ ...orderInput, shippingCountryCode: "US" }).responseCode, "CJ_PREFLIGHT_DESTINATION_UNSUPPORTED");
});

await test("logistics selection uses the cheapest valid quote, matching the profit gate", () => {
  const chosen = selectCjLogistic([
    { logisticName: "CJPacket Ordinary", shippingCost: 5.2, arrivalTime: "8-15" },
    { logisticName: "YunExpress", shippingCost: 4.18, arrivalTime: "7-12" },
    { logisticName: "", shippingCost: 1, arrivalTime: null },
    { logisticName: "Broken", shippingCost: Number.NaN, arrivalTime: null },
  ]);
  assert.equal(chosen?.logisticName, "YunExpress");
  assert.equal(selectCjLogistic([]), null);
  assert.equal(selectCjLogistic([{ logisticName: "Free", shippingCost: 0, arrivalTime: null }]), null);
});

await test("payment is confirmed only by an explicit CJ payment field", () => {
  assert.equal(extractCjPaymentConfirmation({ data: { orderStatus: "UNSHIPPED", paymentDate: "2026-10-13 10:00:00" } }), true);
  assert.equal(extractCjPaymentConfirmation({ data: { orderStatus: "UNSHIPPED", paymentDateTime: 1791887000000 } }), true);
  assert.equal(extractCjPaymentConfirmation({ data: { orderStatus: "UNPAID" } }), false);
  assert.equal(extractCjPaymentConfirmation({ data: { orderStatus: "CREATED", paymentDate: "" } }), false);
  assert.equal(extractCjPaymentConfirmation({ data: { paymentStatus: "success" } }), false, "a generic 'success' is not a payment state");
  assert.equal(extractCjPaymentConfirmation({ data: { payStatus: "PAID" } }), true);
  assert.equal(extractCjPaymentConfirmation(null), false);
});

await test("CJ order statuses map to pending, shipped or closed", () => {
  assert.equal(classifyCjOrderStatus("UNPAID"), "pending");
  assert.equal(classifyCjOrderStatus("UNSHIPPED"), "pending");
  assert.equal(classifyCjOrderStatus("SHIPPED"), "shipped");
  assert.equal(classifyCjOrderStatus("DELIVERED"), "shipped");
  assert.equal(classifyCjOrderStatus("CANCELLED"), "closed");
  assert.equal(classifyCjOrderStatus("SOMETHING_NEW"), "unknown");
});

// --- createCJOrderV2 against mocked HTTP ---------------------------------
const actualClient = await import("../lib/sources/cj/client.ts");
let tokenCalls = 0;
const httpClientMock = mock.module("@/lib/sources/cj/client", {
  namedExports: {
    ...actualClient,
    waitForCJRateLimit: async () => {},
    fetchCJWithRateLimit: async () => {
      tokenCalls += 1;
      return new Response(JSON.stringify({ data: { accessToken: "token" } }), { status: 200 });
    },
  },
});
const { createCJOrderV2 } = await import("../lib/sources/cj/create-order.ts");
const realFetch = globalThis.fetch;
let createCalls = [];
function respond(status, body) {
  globalThis.fetch = async (url, init) => {
    createCalls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}
const createInput = {
  ...orderInput,
  logisticName: "YunExpress",
  fromCountryCode: "CN",
  payType: 2,
  products: [{ vid: "cj-vid-1", quantity: 1 }],
};

await test("createOrderV2 success returns the CJ order id and uses balance payment", async () => {
  createCalls = [];
  respond(200, { code: 200, result: true, message: "Success", data: { orderId: "CJ-ORDER-1", orderNum: "dropship:po-1" } });
  const result = await createCJOrderV2(createInput);
  assert.equal(result.succeeded, true);
  assert.equal(result.supplierOrderId, "CJ-ORDER-1");
  assert.equal(createCalls[0].body.payType, 2);
  assert.equal(createCalls[0].body.orderNumber, "dropship:po-1");
  assert.equal(classifyCreateOrderResult(result).disposition, "created");
});

await test("an explicit CJ business rejection is terminal, not retried", async () => {
  respond(200, { code: 1600200, result: false, message: "Insufficient balance", data: null });
  const result = await createCJOrderV2(createInput);
  assert.equal(result.succeeded, false);
  assert.equal(classifyCreateOrderResult(result).disposition, "explicit_rejection");
});

await test("a definite 4xx is a rejection; 5xx, 408, 429 and unreadable bodies are unknown (throw)", async () => {
  respond(400, { code: 400, result: false, message: "Bad request" });
  const rejected = await createCJOrderV2(createInput);
  assert.equal(rejected.responseCode, "HTTP_400");
  assert.equal(classifyCreateOrderResult(rejected).disposition, "explicit_rejection");
  for (const [status, body] of [[500, { message: "server" }], [502, "<html>bad gateway</html>"], [408, { message: "timeout" }], [429, { message: "throttled" }], [200, "not json"]]) {
    respond(status, body);
    await assert.rejects(() => createCJOrderV2(createInput), /outcome unknown/, `HTTP ${status} must be unknown`);
  }
});

await test("result=true without an order id is ambiguous, never treated as created", async () => {
  respond(200, { code: 200, result: true, message: "Success", data: {} });
  const result = await createCJOrderV2(createInput);
  assert.equal(classifyCreateOrderResult(result).disposition, "ambiguous");
});

await test("missing required createOrderV2 fields fail before any CJ request", async () => {
  createCalls = [];
  tokenCalls = 0;
  await assert.rejects(() => createCJOrderV2({ ...createInput, logisticName: "" }), /logisticName/);
  assert.equal(createCalls.length, 0);
  assert.equal(tokenCalls, 0);
});
globalThis.fetch = realFetch;

// --- adapter behaviour with mocked CJ client -----------------------------
let stock = 5;
let freight = [{ logisticName: "CJPacket", shippingCost: 5.2, arrivalTime: null }, { logisticName: "YunExpress", shippingCost: 4.18, arrivalTime: null }];
let freightThrows = false;
const createOrderCalls = [];
httpClientMock.restore();
mock.module("@/lib/sources/cj/create-order", {
  namedExports: {
    createCJOrderV2: async (input) => {
      createOrderCalls.push(input);
      return { succeeded: true, supplierOrderId: "CJ-ORDER-2", responseCode: "200", responseMessage: "Success", raw: {} };
    },
    getCJOrderStatus: async () => ({ status: "UNSHIPPED", trackingNumber: "CJPKL123", paymentDate: "2026-10-13", paymentDateTime: null, raw: { data: { orderStatus: "UNSHIPPED", paymentDate: "2026-10-13" } } }),
    getCJTrackingInfo: async () => ({ trackingNumber: "CJPKL123", carrier: "Japan Post", trackingUrl: null, shippedAt: "2026-10-15", status: "In transit", lastMileTrackingNumber: "JP123456789", raw: {} }),
  },
});
mock.module("@/lib/sources/cj/client", {
  namedExports: {
    ...actualClient,
    fetchCJVariantStock: async () => stock,
    getCJFreightOptions: async () => {
      if (freightThrows) throw new Error("freight api down");
      return freight;
    },
  },
});
const { cjSupplierAdapter } = await import("../lib/procurement/cj-adapter.ts");

await test("adapter declares order preflight and full order capabilities", () => {
  const capabilities = cjSupplierAdapter.capabilities;
  for (const key of ["orderPreflight", "orderCreation", "payment", "orderStatus", "tracking"]) assert.equal(capabilities[key], true, key);
  assert.equal(typeof cjSupplierAdapter.validateOrderInput, "function");
  // liveOrdering mirrors the real switch, which is hard-disabled for CJ, so
  // auto-procurement eligibility and order execution still refuse CJ.
  process.env.CJ_LIVE_ORDERING = "1";
  assert.equal(capabilities.liveOrdering, false);
  delete process.env.CJ_LIVE_ORDERING;
});

await test("adapter refuses insufficient live stock without calling CJ order creation", async () => {
  stock = 0;
  createOrderCalls.length = 0;
  const result = await cjSupplierAdapter.createOrder(orderInput);
  assert.equal(result.responseCode, "CJ_INVENTORY_UNAVAILABLE");
  assert.equal(classifyCreateOrderResult(result).disposition, "explicit_rejection");
  assert.equal(createOrderCalls.length, 0);
  stock = 5;
});

await test("a failed freight lookup is a definite rejection before any order call", async () => {
  freightThrows = true;
  createOrderCalls.length = 0;
  const result = await cjSupplierAdapter.createOrder(orderInput);
  assert.equal(result.responseCode, "CJ_LOGISTICS_LOOKUP_FAILED");
  assert.equal(classifyCreateOrderResult(result).disposition, "explicit_rejection");
  assert.equal(createOrderCalls.length, 0);
  freightThrows = false;
});

await test("adapter orders with the cheapest logistic, CN origin and balance payment", async () => {
  createOrderCalls.length = 0;
  const result = await cjSupplierAdapter.createOrder(orderInput);
  assert.equal(result.supplierOrderId, "CJ-ORDER-2");
  assert.equal(createOrderCalls.length, 1);
  assert.equal(createOrderCalls[0].logisticName, "YunExpress");
  assert.equal(createOrderCalls[0].fromCountryCode, "CN");
  assert.equal(createOrderCalls[0].payType, 2);
  assert.deepEqual(createOrderCalls[0].products, [{ vid: "cj-vid-1", quantity: 1 }]);
});

await test("adapter preflight blocks non-Japanese destinations before any CJ call", async () => {
  createOrderCalls.length = 0;
  const result = await cjSupplierAdapter.createOrder({ ...orderInput, shippingCountryCode: "US" });
  assert.equal(result.responseCode, "CJ_PREFLIGHT_DESTINATION_UNSUPPORTED");
  assert.equal(createOrderCalls.length, 0);
});

await test("order status reports payment and tracking uses the last-mile number", async () => {
  const status = await cjSupplierAdapter.getOrderStatus("CJ-ORDER-2");
  assert.equal(status?.paymentConfirmed, true);
  const tracking = await cjSupplierAdapter.getTracking("CJ-ORDER-2");
  assert.equal(tracking?.trackingNumber, "JP123456789");
  assert.equal(tracking?.carrier, "Japan Post");
});

await test("CJ live and auto ordering stay hard-disabled even when env flags are set", async () => {
  process.env.CJ_LIVE_ORDERING = "1";
  process.env.CJ_AUTO_ORDERING = "1";
  const { isSupplierLiveOrderingEnabled, isSupplierAutoOrderingEnabled } = await import("../lib/config/env.ts");
  assert.equal(isSupplierLiveOrderingEnabled("cj"), false);
  assert.equal(isSupplierLiveOrderingEnabled("CJ Dropshipping"), false);
  assert.equal(isSupplierAutoOrderingEnabled("cj"), false);
  delete process.env.CJ_LIVE_ORDERING;
  delete process.env.CJ_AUTO_ORDERING;
});

await test("a failed supplier order stops sales of that exact supplier variant", async () => {
  const { stopListingSalesAfterSupplierFailure } = await import("../lib/ordering/supplier-execution.ts");
  const calls = [];
  const db = {
    from(table) {
      const call = { table, payload: null, filters: [] };
      calls.push(call);
      const api = {
        update(payload) { call.payload = payload; return api; },
        eq(column, value) { call.filters.push([column, value]); return api; },
        then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
      };
      return api;
    },
  };
  const stop = await stopListingSalesAfterSupplierFailure(db, { supplierProductId: "cj-pid-1", supplierVariantId: "cj-vid-1", reason: "supplier_order_rejected" });
  assert.equal(stop.ok, true);
  assert.equal(calls[0].table, "shop_listings");
  assert.equal(calls[0].payload.orderable, false);
  assert.equal(calls[0].payload.published, false);
  assert.equal(calls[0].payload.pipeline_reason, "supplier_order_rejected");
  assert.deepEqual(calls[0].filters, [["supplier_product_id", "cj-pid-1"], ["supplier_variant_id", "cj-vid-1"]]);
});

console.log(`CJ order adapter contract: ${results.length} cases passed`);
