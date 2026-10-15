import assert from "node:assert/strict";
import { isRetryableRejectedNewfindEvent } from "../lib/integration/newfind-retry-policy.ts";

assert.equal(isRetryableRejectedNewfindEvent("decorative_craft_object_not_promoted"), true);
assert.equal(isRetryableRejectedNewfindEvent("discovery product missing"), true);
assert.equal(isRetryableRejectedNewfindEvent("discovery product missing after accepted TRACER event"), true);
assert.equal(isRetryableRejectedNewfindEvent("tracer_sales_url_http_404"), false);
assert.equal(isRetryableRejectedNewfindEvent("supplier_inventory_unverified"), false);
assert.equal(isRetryableRejectedNewfindEvent(null), false);
console.log("NEWFIND rejected-event retry policy checks passed");
