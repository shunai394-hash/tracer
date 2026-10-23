import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/shopify/sync-fulfillments.ts", import.meta.url), "utf8");
assert.match(source, /import \{ persistOrderStateUpdate \} from "@\/lib\/ordering\/status-write"/,
  "fulfillment sync must use the shared status-write guard");
assert.match(source, /context: "shopify_fulfillment_sync_state"[\s\S]*?if \(!stateWrite\.ok\)/,
  "a failed order-state persistence must be detected after Shopify fulfillment creation");
assert.match(source, /shopify_fulfillment_state_persist_failed_manual_reconciliation_required/,
  "persistence failure after the external fulfillment requires manual reconciliation");
const guard = source.indexOf("if (!stateWrite.ok)");
const success = source.indexOf("result.synced += 1", guard);
assert.ok(guard >= 0 && success > guard,
  "the synced count must only increment after the local state write succeeds");
assert.match(source, /from\("commerce_orders"\)/,
  "canonical commerce orders must be eligible for Shopify tracking sync");
assert.match(source, /tracerShopifyFulfillmentGroups/,
  "canonical fulfillment sync must persist an idempotency marker");
assert.match(source, /context: "commerce_shopify_fulfillment_sync_state"[\s\S]*?if \(!stateWrite\.ok\)/,
  "canonical fulfillment must not report synced before local persistence succeeds");
assert.match(source, /shopify_fulfillment_line_match_missing/,
  "only supplier-shipped lines with exact Shopify line IDs may be fulfilled");
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/shopify-fulfillment").map((job) => job.schedule),
  ["7,37 * * * *"], "canonical Shopify tracking sync must run every 30 minutes, offset from publication");
console.log("Shopify fulfillment state persistence: fail-closed regression checks passed");
