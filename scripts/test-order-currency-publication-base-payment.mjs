import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compensateShopifyPublication } from "../lib/shopify/publication-rollback.ts";
import { getExistingBaseOrderPaymentPatch } from "../lib/channels/base-order-payment-state.ts";

test("product detail and order creation require JPY instead of silently defaulting currency", async () => {
  const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
  const detail = store.slice(store.indexOf("export async function getShopListingBySlug"), store.indexOf("export async function recordShopFunnelEvent"));
  const checkout = store.slice(store.indexOf("export async function placeShopOrder"));
  assert.match(detail, /\.eq\("currency", "JPY"\)/);
  assert.match(checkout, /\.eq\("currency", "JPY"\)/);
  assert.match(checkout, /currency_not_jpy/);
  assert.match(webhook, /String\(order\.currency \?\? order\.presentment_currency \?\? ""\)/);
  assert.match(webhook, /currency !== "JPY"/);
  assert.doesNotMatch(webhook, /presentment_currency \?\? "JPY"/);
});

test("Shopify DB-write failure after remote publication injects rollback and records blocked state", async () => {
  let unpublished = false;
  let persistedPatch;
  const result = await compensateShopifyPublication({
    productId: "gid://shopify/Product/123",
    originalError: "simulated_db_write_failure",
    now: () => "2026-10-12T00:00:00.000Z",
    unpublish: async (id) => {
      assert.equal(id, "gid://shopify/Product/123");
      unpublished = true;
    },
    persist: async (patch) => {
      persistedPatch = patch;
      return { error: null };
    },
  });
  assert.equal(unpublished, true);
  assert.equal(result.unpublished, true);
  assert.equal(result.statePersisted, true);
  assert.equal(persistedPatch.published, false);
  assert.equal(persistedPatch.pipeline_stage, "BLOCKED");
  assert.equal(persistedPatch.shopify_sync_status, "blocked");
  assert.match(persistedPatch.shopify_sync_error, /simulated_db_write_failure/);
});

test("Shopify rollback records a failed state if unpublication also fails", async () => {
  let persistedPatch;
  const result = await compensateShopifyPublication({
    productId: "gid://shopify/Product/456",
    originalError: "simulated_db_write_failure",
    unpublish: async () => { throw new Error("simulated_unpublish_failure"); },
    persist: async (patch) => { persistedPatch = patch; return { error: null }; },
  });
  assert.equal(result.unpublished, false);
  assert.equal(result.statePersisted, true);
  assert.equal(persistedPatch.published, false);
  assert.equal(persistedPatch.shopify_sync_status, "failed");
  assert.match(result.error, /simulated_unpublish_failure/);
});

test("Shopify rollback surfaces a second DB failure rather than claiming state reconciliation", async () => {
  const result = await compensateShopifyPublication({
    productId: "gid://shopify/Product/789",
    originalError: "simulated_db_write_failure",
    unpublish: async () => {},
    persist: async () => { throw new Error("simulated_rollback_state_write_failure"); },
  });
  assert.equal(result.unpublished, true);
  assert.equal(result.statePersisted, false);
  assert.match(result.error, /state_write_failed:simulated_rollback_state_write_failure/);
});

test("BASE stale unpaid read cannot downgrade a previously paid order", () => {
  assert.deepEqual(
    getExistingBaseOrderPaymentPatch({
      existingPaymentStatus: "paid",
      existingOrderStatus: "fulfillment_pending",
      paid: false,
      canceled: false,
    }),
    {},
  );
  assert.deepEqual(
    getExistingBaseOrderPaymentPatch({
      existingPaymentStatus: "pending",
      existingOrderStatus: "pending_payment",
      paid: false,
      canceled: false,
    }),
    { payment_status: "pending", order_status: "pending_payment" },
  );
  assert.deepEqual(
    getExistingBaseOrderPaymentPatch({
      existingPaymentStatus: "pending",
      existingOrderStatus: "pending_payment",
      paid: true,
      canceled: false,
    }),
    { payment_status: "paid", order_status: "fulfillment_pending" },
  );
});
