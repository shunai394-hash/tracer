import assert from "node:assert/strict";
import { validateShopifyWebhookOrder } from "../lib/shopify/webhook-order-validation.ts";

const valid = {
  line_items: [{ sku: "TRC-variant-1", quantity: 2, price: "1200.00" }],
  shipping_address: { address1: "1-2-3 Example" },
  subtotal_price: "2400.00",
  total_price: "2500.00",
  currency: "JPY",
};
assert.deepEqual(validateShopifyWebhookOrder(valid), {
  ok: true, subtotal: 2400, total: 2500, currency: "JPY",
});
assert.equal(validateShopifyWebhookOrder({ ...valid, line_items: [] }).reason, "line_items_missing");
assert.equal(validateShopifyWebhookOrder({ ...valid, line_items: [{ ...valid.line_items[0], quantity: 0 }] }).reason, "line_item_1_quantity_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, line_items: [{ ...valid.line_items[0], quantity: -1 }] }).reason, "line_item_1_quantity_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, line_items: [{ ...valid.line_items[0], quantity: 1.5 }] }).reason, "line_item_1_quantity_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, line_items: [{ ...valid.line_items[0], price: null }] }).reason, "line_item_1_price_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, total_price: null }).reason, "order_amount_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, subtotal_price: " " }).reason, "order_amount_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, currency: "jpy" }).reason, "order_currency_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, currency: null }).reason, "order_currency_invalid");
assert.equal(validateShopifyWebhookOrder({ ...valid, shipping_address: null }).reason, "shipping_address_missing");
assert.equal(validateShopifyWebhookOrder({ ...valid, line_items: [{ ...valid.line_items[0], sku: " " }] }).reason, "listing_sku_missing");
console.log("Shopify webhook payload validation: 12 assertions passed");
