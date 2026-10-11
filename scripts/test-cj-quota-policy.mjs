import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getCJQuotaCooldownUntil,
  getCJSharedLimiterFailureCode,
  isCJQuotaExhausted,
} from "../lib/sources/cj/rate-limit-policy.ts";

assert.equal(isCJQuotaExhausted({
  code: 1600200,
  message: "Too Many Requests, QPS limit is 1 time/1second",
  pointsInfo: { total: 0, usedToday: 0, remaining: 0 },
}), true);
assert.equal(isCJQuotaExhausted({
  code: 1600200,
  message: "Too Many Requests, QPS limit is 1 time/1second",
  pointsInfo: { total: 100, usedToday: 99, remaining: 1 },
}), false);
assert.equal(isCJQuotaExhausted({ code: 16900500, message: "quota exhausted" }), true);
assert.equal(isCJQuotaExhausted({ code: 1600200, message: "QPS limit is 1 time/1second" }), false);
assert.equal(
  getCJQuotaCooldownUntil(Date.parse("2026-10-12T00:00:00.000Z")),
  "2026-10-13T00:00:00.000Z",
);
assert.equal(getCJSharedLimiterFailureCode(), "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN");

// Guard the integration boundary: outbound fetch must await the shared gate,
// and the removed per-instance fallback must not be reintroduced.
const clientSource = readFileSync(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
const fetchGate = clientSource.indexOf("await waitForCJRateLimit();");
const outboundFetch = clientSource.indexOf("const response = await fetch(input, init);");
assert.ok(fetchGate >= 0 && outboundFetch > fetchGate, "CJ fetch must wait for shared limiter first");
assert.ok(!clientSource.includes("waitForLocalCJRateLimit"), "no process-local fallback is allowed");
assert.ok(clientSource.includes('getCJSharedLimiterFailureCode()'), "shared limiter failure must be fail-closed");

console.log("CJ quota policy: 9 assertions passed");
