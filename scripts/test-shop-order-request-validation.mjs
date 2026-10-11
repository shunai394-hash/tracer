import assert from "node:assert/strict";
import {
  normalizeShopOrderPaymentMethod,
  validateShopOrderItems,
} from "../lib/shop/checkout-request-validation.ts";

assert.deepEqual(validateShopOrderItems(undefined), { ok: false, reason: "items_required" });
assert.deepEqual(validateShopOrderItems([]), { ok: false, reason: "items_required" });
assert.deepEqual(validateShopOrderItems([null]), { ok: false, reason: "item_1_invalid" });
assert.deepEqual(validateShopOrderItems([{ listingId: " ", qty: 1 }]), {
  ok: false,
  reason: "item_1_listing_id_required",
});
assert.deepEqual(validateShopOrderItems([{ listingId: "x", qty: 0 }]), {
  ok: false,
  reason: "item_1_quantity_invalid",
});
assert.deepEqual(validateShopOrderItems([{ listingId: "x", qty: -1 }]), {
  ok: false,
  reason: "item_1_quantity_invalid",
});
assert.deepEqual(validateShopOrderItems([{ listingId: "x", qty: 1.5 }]), {
  ok: false,
  reason: "item_1_quantity_invalid",
});
assert.deepEqual(validateShopOrderItems([{ listingId: "x", qty: "2" }]), {
  ok: false,
  reason: "item_1_quantity_invalid",
});
assert.deepEqual(validateShopOrderItems([{ listingId: "x", qty: Number.MAX_SAFE_INTEGER + 1 }]), {
  ok: false,
  reason: "item_1_quantity_invalid",
});
assert.deepEqual(validateShopOrderItems([{ listingId: "x", qty: 1 }, { listingId: "x", qty: 2 }]), {
  ok: false,
  reason: "duplicate_listing_id",
});
assert.deepEqual(validateShopOrderItems([{ listingId: "  product-1 ", qty: 2 }]), {
  ok: true,
  items: [{ listingId: "product-1", qty: 2 }],
});
assert.deepEqual(validateShopOrderItems(Array.from({ length: 101 }, (_, i) => ({
  listingId: `product-${i}`,
  qty: 1,
}))), { ok: false, reason: "too_many_items" });
assert.deepEqual(normalizeShopOrderPaymentMethod(undefined), "cash_on_delivery");
assert.deepEqual(normalizeShopOrderPaymentMethod(null), "cash_on_delivery");
assert.deepEqual(normalizeShopOrderPaymentMethod("card"), "card");
assert.deepEqual(normalizeShopOrderPaymentMethod("bank_transfer"), "bank_transfer");
assert.deepEqual(normalizeShopOrderPaymentMethod("cash_on_delivery"), "cash_on_delivery");
assert.deepEqual(normalizeShopOrderPaymentMethod("wire_me_money"), null);
assert.deepEqual(normalizeShopOrderPaymentMethod(1), null);

console.log("Checkout request validation: 18 assertions passed");
