import assert from "node:assert/strict";
import { evaluateChannelDeliveryHealth } from "../lib/market/channel-delivery-health.ts";

const cases = [
  {
    name: "both channels complete",
    input: { selectedCount: 2, shopify: { configured: true, attempted: 2, synced: 2, failedCount: 0 }, base: { results: [{ ok: true, baseItemId: "base-1" }, { ok: true, baseItemId: "base-2" }] } },
    expected: { ok: true, failedCount: 0, shopifyFailed: 0, baseFailed: 0 },
  },
  {
    name: "BASE failure does not get hidden by Shopify success",
    input: { selectedCount: 2, shopify: { configured: true, attempted: 2, synced: 2, failedCount: 0 }, base: { results: [{ ok: true, baseItemId: "base-1" }, { ok: false, error: "token_expired" }] } },
    expected: { ok: false, failedCount: 1, shopifyFailed: 0, baseFailed: 1 },
  },
  {
    name: "Shopify failure does not get hidden by BASE success",
    input: { selectedCount: 2, shopify: { configured: true, attempted: 2, synced: 1, failedCount: 1 }, base: { results: [{ ok: true, baseItemId: "base-1" }, { ok: true, baseItemId: "base-2" }] } },
    expected: { ok: false, failedCount: 1, shopifyFailed: 1, baseFailed: 0 },
  },
  {
    name: "unconfigured Shopify is not falsely reported successful",
    input: { selectedCount: 1, shopify: { configured: false, attempted: 0, synced: 0, failedCount: 0 }, base: { results: [{ ok: true, baseItemId: "base-1" }] } },
    expected: { ok: false, failedCount: 1, shopifyFailed: 1, baseFailed: 0 },
  },
  {
    name: "missing BASE external ID is incomplete",
    input: { selectedCount: 1, shopify: { configured: true, attempted: 1, synced: 1, failedCount: 0 }, base: { results: [{ ok: true, baseItemId: null }] } },
    expected: { ok: false, failedCount: 1, shopifyFailed: 0, baseFailed: 1 },
  },
  {
    name: "empty batch is a successful no-op",
    input: { selectedCount: 0, shopify: { configured: false, attempted: 0, synced: 0, failedCount: 0 }, base: { results: [] } },
    expected: { ok: true, failedCount: 0, shopifyFailed: 0, baseFailed: 0 },
  },
];
for (const item of cases) {
  assert.deepEqual(evaluateChannelDeliveryHealth(item.input), item.expected, item.name);
}
console.log(`Channel delivery health: ${cases.length} scenarios passed`);
