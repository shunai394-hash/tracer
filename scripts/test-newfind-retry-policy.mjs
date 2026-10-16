import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRetryableRejectedNewfindEvent } from "../lib/integration/newfind-retry-policy.ts";

const reconcileSource = readFileSync(new URL("../lib/integration/newfind-reconcile.ts", import.meta.url), "utf8");
assert.match(reconcileSource, /last_attempt_at/, "recovery must compare listing updates with the previous delivery attempt");
assert.match(reconcileSource, /staleSalesUrlFailure/, "only stale sales URL failures should be re-queued");
assert.match(reconcileSource, /listingUpdatedAt > lastAttemptAt/, "do not retry a still-unavailable URL every five minutes");

assert.equal(isRetryableRejectedNewfindEvent("decorative_craft_object_not_promoted"), true);
assert.equal(isRetryableRejectedNewfindEvent("discovery product missing"), true);
assert.equal(isRetryableRejectedNewfindEvent("discovery product missing after accepted TRACER event"), true);
assert.equal(isRetryableRejectedNewfindEvent("tracer_sales_url_http_404"), false);
assert.equal(isRetryableRejectedNewfindEvent("supplier_inventory_unverified"), false);
assert.equal(isRetryableRejectedNewfindEvent(null), false);
console.log("NEWFIND rejected-event retry policy checks passed");
