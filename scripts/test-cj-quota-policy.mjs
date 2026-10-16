import assert from "node:assert/strict";
import { getCJQuotaCooldownUntil, isCJQuotaCircuitActive, isCJQuotaExhausted } from "../lib/sources/cj/rate-limit-policy.ts";
import { isWithinCjQuotaResetReservation } from "../lib/suppliers/cj-identity-reverify-policy.ts";
import { isCjIdentityReverifyDue } from "../lib/suppliers/cj-identity-reverify-policy.ts";

assert.equal(isCJQuotaExhausted({
  code: 1600200,
  message: "Too Many Requests, QPS limit is 1 time/1second",
  pointsInfo: { total: 0, usedToday: 0, remaining: 0 },
}), false);
assert.equal(isCJQuotaExhausted({
  code: 1600200,
  message: "Too Many Requests, QPS limit is 1 time/1second",
  pointsInfo: { total: 100, usedToday: 99, remaining: 1 },
}), false);
assert.equal(isCJQuotaExhausted({ code: 16900500, message: "quota exhausted" }), true);
assert.equal(isCJQuotaExhausted({ code: 1600200, message: "QPS limit is 1 time/1second" }), false);
assert.equal(isCJQuotaCircuitActive({ blockedUntil: "2026-10-17T00:05:19.577Z", reason: "provider_points_remaining_zero" }, Date.parse("2026-10-16T05:40:00.000Z")), false);
assert.equal(isCJQuotaCircuitActive({ blockedUntil: "2026-10-17T00:05:19.577Z", reason: "provider_explicit_daily_points_exhausted" }, Date.parse("2026-10-16T05:40:00.000Z")), true);
assert.equal(
  getCJQuotaCooldownUntil(Date.parse("2026-10-12T00:00:00.000Z")),
  "2026-10-13T00:00:00.000Z",
);
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-15T23:54:00.000Z")), false);
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-15T23:55:00.000Z")), true);
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-16T00:04:00.000Z")), true);
assert.equal(isWithinCjQuotaResetReservation(new Date("2026-10-16T00:05:00.000Z")), false);
const now = Date.parse("2026-10-16T07:00:00.000Z");
assert.equal(isCjIdentityReverifyDue({
  next_identity_reverify_at: "2026-10-17T07:00:00.000Z",
  missing_supply_evidence_errors: ["cost:returned_variant_or_product_id_mismatch"],
}, now), true);
assert.equal(isCjIdentityReverifyDue({
  next_identity_reverify_at: "2026-10-17T07:00:00.000Z",
  missing_supply_evidence_errors: ["cost:timeout"],
}, now), false);
assert.equal(isCjIdentityReverifyDue({
  next_identity_reverify_at: "2026-10-17T07:00:00.000Z",
  missing_supply_evidence_errors: ["cost:returned_variant_or_product_id_mismatch"],
  legacy_parent_id_mismatch_retry_attempted_at: "2026-10-16T06:00:00.000Z",
}, now), false);
console.log("CJ quota and legacy identity retry policy: 14 assertions passed");
