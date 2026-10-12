import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldPreserveBaseOrderState } from "../lib/channels/base-order-state.ts";

const syncSource = readFileSync(new URL("../lib/channels/base-orders.ts", import.meta.url), "utf8");

test("BASE reimport preserves refund, cancellation, and refunded payment states", () => {
  for (const status of ["cancellation_requested", "refund_pending", "cancelled", "refunded"]) {
    assert.equal(shouldPreserveBaseOrderState(status, "pending"), true, status);
  }
  assert.equal(shouldPreserveBaseOrderState("pending_payment", "refunded"), true);
  assert.equal(shouldPreserveBaseOrderState("pending_payment", "pending"), false);
  assert.equal(shouldPreserveBaseOrderState("fulfillment_pending", "paid"), false);
});

test("protected BASE order state branch continues before procurement creation", () => {
  const guard = syncSource.indexOf("if (shouldPreserveBaseOrderState(existing.order_status, existing.payment_status))");
  const continueIndex = syncSource.indexOf("          continue;", guard);
  const procurementIndex = syncSource.indexOf("createDropshipPurchaseOrdersForShopOrder(String(existing.id))", guard);
  assert.ok(guard >= 0 && continueIndex > guard, "protected state branch must continue");
  assert.ok(procurementIndex > continueIndex, "protected state branch must skip procurement creation");
});
