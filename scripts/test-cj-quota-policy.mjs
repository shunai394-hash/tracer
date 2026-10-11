import assert from "node:assert/strict";
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

// Shared limiter failures must map to the circuit-unknown blocking code.
// The client uses this policy when the shared RPC fails; callers must not
// fall back to a process-local limiter that cannot coordinate Vercel instances.
assert.equal(getCJSharedLimiterFailureCode(), "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN");

console.log("CJ quota policy: 6 assertions passed");
