import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  NEWFIND_COMMERCE_MAX_ATTEMPTS,
  decideNewfindCommerceDelivery,
  initialNewfindCommerceDetail,
  newfindCommerceBackoffMs,
  newfindCommerceEventId,
  newfindCommerceEventKey,
  newfindCommerceOutcome,
} from "../lib/integration/newfind-commerce-ledger.ts";

let cases = 0;
const check = (name, fn) => { fn(); cases += 1; };
const variant = "33333333-3333-4333-8333-333333333333";
const now = Date.parse("2026-10-17T00:00:00Z");
const detail = (patch) => ({ ...initialNewfindCommerceDetail(variant), ...patch });

check("keys are per variant and the receiver event id is stable", () => {
  assert.equal(newfindCommerceEventKey(variant), `newfind_commerce:${variant}`);
  assert.equal(newfindCommerceEventId(variant), `tracer-commerce-variant:${variant}`);
});
check("never-sent variants are sent", () => {
  const decision = decideNewfindCommerceDelivery(variant, null, now);
  assert.equal(decision.action, "send");
  assert.equal(decision.fromStatus, "missing");
});
check("processed variants are never re-sent", () => {
  assert.deepEqual(decideNewfindCommerceDelivery(variant, { status: "processed", detail: detail({ attempts: 1 }) }, now), { action: "skip", reason: "already_processed" });
});
check("a live lease blocks a second sender; an expired one is reclaimed with the same event id", () => {
  const live = detail({ attempts: 1, leaseUntil: new Date(now + 60_000).toISOString(), lastAttemptAt: new Date(now - 60_000).toISOString() });
  assert.deepEqual(decideNewfindCommerceDelivery(variant, { status: "sending", detail: live }, now), { action: "skip", reason: "in_progress" });
  const expired = detail({ attempts: 1, leaseUntil: new Date(now - 1).toISOString(), lastAttemptAt: new Date(now - 60 * 60_000).toISOString() });
  const decision = decideNewfindCommerceDelivery(variant, { status: "sending", detail: expired }, now);
  assert.equal(decision.action, "send");
  assert.equal(decision.detail.eventId, newfindCommerceEventId(variant));
});
check("failures back off and stop after the attempt cap", () => {
  const recent = detail({ attempts: 2, lastAttemptAt: new Date(now - 60_000).toISOString() });
  assert.deepEqual(decideNewfindCommerceDelivery(variant, { status: "failed", detail: recent }, now), { action: "skip", reason: "backoff" });
  const old = detail({ attempts: 2, lastAttemptAt: new Date(now - newfindCommerceBackoffMs(2) - 1).toISOString() });
  assert.equal(decideNewfindCommerceDelivery(variant, { status: "failed", detail: old }, now).action, "send");
  const capped = detail({ attempts: NEWFIND_COMMERCE_MAX_ATTEMPTS, lastAttemptAt: new Date(now - 24 * 60 * 60_000).toISOString() });
  assert.deepEqual(decideNewfindCommerceDelivery(variant, { status: "failed", detail: capped }, now), { action: "skip", reason: "max_attempts" });
  assert.equal(newfindCommerceBackoffMs(100), 6 * 60 * 60_000);
});
check("only a processed or duplicate ACK completes delivery", () => {
  assert.equal(newfindCommerceOutcome({ ok: true, status: 200, ackStatus: "processed" }), "processed");
  assert.equal(newfindCommerceOutcome({ ok: true, status: 200, ackStatus: "duplicate" }), "processed");
  assert.equal(newfindCommerceOutcome({ ok: true, status: 202, ackStatus: "queued" }), "sent");
  assert.equal(newfindCommerceOutcome({ ok: false, status: 422, ackStatus: null }), "failed");
  assert.equal(newfindCommerceOutcome(null), "failed");
});

const [source, patrol, status] = await Promise.all([
  readFile(new URL("../lib/integration/newfind-commerce.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cron/patrol-ai/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/admin/commerce/status/route.ts", import.meta.url), "utf8"),
]);
check("delivery is gated on the receiver flag, claims by compare-and-set and checks the live TRACER URL first", () => {
  assert.match(source, /NEWFIND_TRACER_PROMOTION_RECEIVER_READY\?\.trim\(\) === "1"/);
  assert.match(source, /if \(!receiverReady \|\| !configured\) return result;/);
  assert.match(source, /\.eq\("event_key", key\)\.eq\("status", fromStatus\)/);
  assert.match(source, /claim = claim\.lt\("detail->>leaseUntil", now\.toISOString\(\)\)/);
  const claimAt = source.indexOf("await claim.select");
  const liveAt = source.indexOf("await resolveLiveTracerUrl(listing.id)");
  const postAt = source.indexOf("await fetch(buildUrl(");
  assert.ok(claimAt > 0 && claimAt < liveAt && liveAt < postAt);
  assert.match(source, /loadCanonicalCommerceListings\(\)/);
});
check("patrol runs the commerce delivery within its time budget", () => {
  assert.match(patrol, /promoteCommerceListingsToNewfind\(\{ limit: 2, deadlineAt: startedAt \+ 285_000 \}\)/);
  assert.match(patrol, /if \(Date\.now\(\) < startedAt \+ 250_000\) \{/);
});
check("status reports both NEWFIND ledgers without writing", () => {
  assert.match(status, /newfind_promotion_deliveries/);
  assert.match(status, /newfind_commerce_delivery/);
  assert.doesNotMatch(status, /\.(insert|update|upsert|delete)\(/);
});

console.log(`newfind commerce delivery: ${cases} cases passed`);
