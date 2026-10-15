import assert from "node:assert/strict";
import { getCJQuotaCooldownUntil, isCJQuotaExhausted } from "../lib/sources/cj/rate-limit-policy.ts";
import { isWithinCjQuotaResetReservation } from "../lib/suppliers/cj-identity-reverify-policy.ts";

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
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-15T23:54:00.000Z")), false);
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-15T23:55:00.000Z")), true);
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-16T00:04:00.000Z")), true);
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-16T00:05:00.000Z")), false);
console.log("CJ quota policy: 9 assertions passed");
