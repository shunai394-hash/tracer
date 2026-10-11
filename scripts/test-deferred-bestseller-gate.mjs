import assert from "node:assert/strict";
import { canFeedSalesGate } from "../lib/intelligence/bestseller-sales-gate.ts";

assert.equal(canFeedSalesGate({ ok: true }), true, "completed stage can feed sales gate");
assert.equal(canFeedSalesGate({ ok: true, skipped: true }), false, "skipped stage is blocked");
assert.equal(canFeedSalesGate({ ok: true, retryable: true }), false, "retryable stage is blocked");
assert.equal(canFeedSalesGate({ ok: true, skipped: true, retryable: true }), false, "deferred stage is blocked");
assert.equal(canFeedSalesGate({ ok: false }), false, "failed stage is blocked");
console.log("bestseller sales-gate behavior verified");
