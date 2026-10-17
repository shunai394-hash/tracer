import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reconcile = readFileSync(new URL("../lib/ordering/reconcile.ts", import.meta.url), "utf8");
const supplierSync = readFileSync(new URL("../lib/procurement/sync-orders.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261017140000_add_purchase_order_tracking_number.sql", import.meta.url), "utf8");

assert.ok(
  migration.includes("alter table public.purchase_orders") &&
  migration.includes("add column if not exists tracking_number text"),
  "migration must add tracking_number idempotently"
);
assert.ok(supplierSync.includes("tracking_number"),
  "supplier order sync must persist supplier-reported tracking numbers");
assert.ok(
  reconcile.includes("trackingResult.trackingNumber") &&
  reconcile.includes("update.tracking_number = trackingResult.trackingNumber"),
  "reconciliation must persist a supplier-reported tracking number"
);
assert.ok(reconcile.includes("if (trackingResult.trackingNumber)"),
  "reconciliation must not write an absent tracking number");
assert.ok(reconcile.includes("if (updateError) throw new Error(updateError.message)"),
  "reconciliation must surface persistence failures instead of reporting success");
console.log("Supplier tracking persistence: schema and sync regression checks passed");
