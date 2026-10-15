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
console.log("Shopify fulfillment state persistence: fail-closed regression checks passed");
