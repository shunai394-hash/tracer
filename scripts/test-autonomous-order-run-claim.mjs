import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/ordering/autonomous-control.ts", import.meta.url), "utf8");

assert.match(source, /automation_stale_claim_recovery_failed/);
assert.match(source, /10 \* 60_000/);
assert.match(source, /\.eq\("status", "running"\)\s*\.lt\("started_at", staleBefore\)/);
assert.ok(
  source.indexOf("staleClaims") < source.indexOf("existingRunQuery"),
  "stale claims must be reclaimed before acquiring a new hourly run claim",
);
assert.match(source, /automation_run_claim_lookup_failed/);
assert.match(source, /automation_run_already_claimed/);
assert.match(source, /automation_run_claim_lost/);
assert.match(source, /automation_run_claim_insert_failed/);
assert.match(source, /automation_run_claim_insert_missing_id/);
assert.match(source, /automation_run_finalization_failed/);
assert.doesNotMatch(source, /auditPersistence/);
assert.doesNotMatch(source, /degraded:\$\{runKey\}/);
assert.ok(
  source.indexOf('from("order_automation_runs")') < source.indexOf('from("shop_orders")'),
  "durable run claim must be acquired before loading customer orders",
);
assert.ok(
  source.indexOf("automation_run_claim_insert_failed") < source.indexOf('from("shop_orders")'),
  "a failed run claim must stop before loading orders",
);
assert.ok(
  source.indexOf("automation_run_finalization_failed") > source.indexOf("executeVerifiedSupplierPurchaseOrder"),
  "run completion must be durably recorded after supplier execution",
);
console.log("Autonomous order run-claim safety: 11 assertions passed");
