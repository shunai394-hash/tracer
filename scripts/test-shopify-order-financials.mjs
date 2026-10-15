import assert from "node:assert/strict";
import { validateShopifyOrderFinancials } from "../lib/ordering/shopify-order-financials.ts";

const validOrder = {
  currency: "JPY",
  presentment_currency: "USD",
  subtotal_price: "1800.00",
  total_price: "2200.00",
};
const validItems = [
  { id: "line-1", quantity: 2, price: "900.00" },
  { id: "line-2", quantity: "1", price: 0 },
];

let result = validateShopifyOrderFinancials(validOrder, validItems);
assert.equal(result.ok, true);
if (result.ok) {
  assert.equal(result.currency, "JPY");
  assert.equal(result.subtotal, 1800);
  assert.equal(result.total, 2200);
  assert.deepEqual(result.lineAmounts, [
    { quantity: 2, unitPrice: 900 },
    { quantity: 1, unitPrice: 0 },
  ]);
}

result = validateShopifyOrderFinancials({ ...validOrder, currency: undefined }, validItems);
assert.deepEqual(result, { ok: false, reason: "shopify_order_currency_missing" });

result = validateShopifyOrderFinancials({ presentment_currency: "JPY", subtotal_price: 1, total_price: 1 }, validItems);
assert.deepEqual(result, { ok: false, reason: "shopify_order_currency_missing" });

result = validateShopifyOrderFinancials({ ...validOrder, currency: "   " }, validItems);
assert.deepEqual(result, { ok: false, reason: "shopify_order_currency_missing" });

result = validateShopifyOrderFinancials({ ...validOrder, total_price: null }, validItems);
assert.deepEqual(result, { ok: false, reason: "shopify_order_totals_invalid" });

result = validateShopifyOrderFinancials({ ...validOrder, subtotal_price: "NaN" }, validItems);
assert.deepEqual(result, { ok: false, reason: "shopify_order_totals_invalid" });

result = validateShopifyOrderFinancials(validOrder, [{ id: "line-1", quantity: 0, price: 100 }]);
assert.deepEqual(result, { ok: false, reason: "shopify_order_line_amounts_invalid" });

result = validateShopifyOrderFinancials(validOrder, [{ id: "line-1", quantity: 1.5, price: 100 }]);
assert.deepEqual(result, { ok: false, reason: "shopify_order_line_amounts_invalid" });

result = validateShopifyOrderFinancials(validOrder, [{ id: "line-1", quantity: 1, price: -0.01 }]);
assert.deepEqual(result, { ok: false, reason: "shopify_order_line_amounts_invalid" });

result = validateShopifyOrderFinancials(validOrder, [{ id: "line-1", quantity: " ", price: " " }]);
assert.deepEqual(result, { ok: false, reason: "shopify_order_line_amounts_invalid" });

console.log("Shopify order financial validation: 10 assertions passed");
