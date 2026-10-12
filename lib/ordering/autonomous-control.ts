import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createDropshipPurchaseOrdersForShopOrder } from "@/lib/ordering/dropship";
import { executeVerifiedSupplierPurchaseOrder } from "@/lib/ordering/verified-supplier-execution";
import { initializeProcurement } from "@/lib/procurement/init";

type RunResult = {
  runId: string;
  processed: number;
  succeeded: number;
  failed: number;
  purchaseOrderIds: string[];
};

async function recordEvent(args: {
  eventKey: string;
  purchaseOrderId?: string | null;
  shopOrderId?: string | null;
  eventType: string;
  status: "recorded" | "actioned" | "ignored" | "failed";
  payload?: Record<string, unknown>;
}) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("order_automation_events").upsert({
    event_key: args.eventKey,
    purchase_order_id: args.purchaseOrderId ?? null,
    shop_order_id: args.shopOrderId ?? null,
    event_type: args.eventType,
    status: args.status,
    payload: args.payload ?? {},
  }, { onConflict: "event_key" });

  if (error && error.code !== "42501" && error.code !== "42P01") {
    throw new Error(error.message);
  }
  if (error) {
    console.warn("[TRACER AUTOMATION EVENT AUDIT SKIPPED]", error.message);
  }
}

/**
 * Autonomous order control plane.
 *
 * It deliberately separates:
 * 1. order discovery,
 * 2. idempotent PO creation,
 * 3. live execution,
 * 4. reconciliation.
 *
 * A retry can therefore resume from any boundary without creating a second
 * customer order or a second supplier order.
 */
export async function runAutonomousOrderControl(runKey: string): Promise<RunResult> {
  initializeProcurement();
  const supabase = createSupabaseAdminClient();

  // Vercel can terminate a request before its run row is finalized. Reclaim
  // only rows older than ten minutes: every caller of this control plane has
  // a shorter execution budget (60–300s), so this cannot steal a live claim.
  // This is run-ledger maintenance only; it never retries a supplier order.
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const staleClaims = await supabase
    .from("order_automation_runs")
    .update({ status: "failed", finished_at: new Date().toISOString() })
    .eq("status", "running")
    .lt("started_at", staleBefore);
  if (staleClaims.error) {
    throw new Error(`automation_stale_claim_recovery_failed:${staleClaims.error.message}`);
  }

  // The run row is an execution claim, not optional telemetry. If it cannot
  // be persisted, stop before reading orders or calling suppliers.
  const existingRunQuery = await supabase
    .from("order_automation_runs")
    .select("id,status,processed_count,succeeded_count,failed_count")
    .eq("run_key", runKey)
    .maybeSingle();

  if (existingRunQuery.error) {
    throw new Error(`automation_run_claim_lookup_failed:${existingRunQuery.error.message}`);
  }

  if (existingRunQuery.data) {
    if (existingRunQuery.data.status === "completed") {
      return {
        runId: String(existingRunQuery.data.id),
        processed: Number(existingRunQuery.data.processed_count ?? 0),
        succeeded: Number(existingRunQuery.data.succeeded_count ?? 0),
        failed: Number(existingRunQuery.data.failed_count ?? 0),
        purchaseOrderIds: [],
      };
    }
    // A running or failed claim may have an ambiguous supplier-side outcome.
    // Do not replay it under the same key; reconcile first and use a new key.
    throw new Error(`automation_run_already_claimed:${String(existingRunQuery.data.status ?? "unknown")}`);
  }

  const insertedRun = await supabase
    .from("order_automation_runs")
    .insert({ run_key: runKey, mode: "scheduled", status: "running" })
    .select("id")
    .single();

  if (insertedRun.error) {
    if (insertedRun.error.code === "23505") {
      const racedRun = await supabase
        .from("order_automation_runs")
        .select("id,status,processed_count,succeeded_count,failed_count")
        .eq("run_key", runKey)
        .maybeSingle();
      if (racedRun.error) {
        throw new Error(`automation_run_claim_race_lookup_failed:${racedRun.error.message}`);
      }
      if (racedRun.data?.status === "completed") {
        return {
          runId: String(racedRun.data.id),
          processed: Number(racedRun.data.processed_count ?? 0),
          succeeded: Number(racedRun.data.succeeded_count ?? 0),
          failed: Number(racedRun.data.failed_count ?? 0),
          purchaseOrderIds: [],
        };
      }
      throw new Error(`automation_run_claim_lost:${String(racedRun.data?.status ?? "unknown")}`);
    }
    throw new Error(`automation_run_claim_insert_failed:${insertedRun.error.message}`);
  }
  if (!insertedRun.data?.id) throw new Error("automation_run_claim_insert_missing_id");
  const runId = String(insertedRun.data.id);

  const { data: orders, error } = await supabase
    .from("shop_orders")
    .select("id,payment_status,order_status")
    .eq("payment_status", "paid")
    .in("order_status", ["paid", "placed", "processing", "fulfillment_pending"])
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) throw new Error(error.message);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const purchaseOrderIds: string[] = [];

  for (const order of orders ?? []) {
    const shopOrderId = String(order.id);
    processed += 1;

    try {
      const procurement = await createDropshipPurchaseOrdersForShopOrder(shopOrderId);
      for (const poId of procurement.purchaseOrderIds) {
        purchaseOrderIds.push(poId);
        await recordEvent({
          eventKey: `po-created:${poId}`,
          purchaseOrderId: poId,
          shopOrderId,
          eventType: "purchase_order_created",
          status: "actioned",
          payload: { run_key: runKey, source: "autonomous_order_control" },
        });

        const execution = await executeVerifiedSupplierPurchaseOrder(poId);
        if (execution.succeeded) {
          succeeded += 1;
          await recordEvent({
            eventKey: `po-executed:${poId}:${execution.supplierOrderId ?? "unknown"}`,
            purchaseOrderId: poId,
            shopOrderId,
            eventType: "supplier_order_executed",
            status: "actioned",
            payload: {
              supplier: execution.supplierName,
              supplier_order_id: execution.supplierOrderId,
              reason: execution.reason,
            },
          });
        } else {
          failed += 1;
          await recordEvent({
            eventKey: `po-execution-failed:${poId}`,
            purchaseOrderId: poId,
            shopOrderId,
            eventType: "supplier_order_blocked_or_failed",
            status: "failed",
            payload: {
              supplier: execution.supplierName,
              reason: execution.reason,
              gate: execution.gate,
            },
          });
        }
      }

      if (procurement.skipped.length > 0) {
        await recordEvent({
          eventKey: `shop-order-skipped:${shopOrderId}:${runKey}`,
          shopOrderId,
          eventType: "purchase_order_creation_skipped",
          status: "ignored",
          payload: { skipped: procurement.skipped },
        });
      }
    } catch (error) {
      failed += 1;
      await recordEvent({
        eventKey: `shop-order-error:${shopOrderId}:${runKey}`,
        shopOrderId,
        eventType: "autonomous_order_error",
        status: "failed",
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const { error: runUpdateError } = await supabase
    .from("order_automation_runs")
    .update({
      status: failed > 0 && succeeded === 0 ? "failed" : "completed",
      finished_at: new Date().toISOString(),
      processed_count: processed,
      succeeded_count: succeeded,
      failed_count: failed,
    })
    .eq("id", runId);

  if (runUpdateError) {
    throw new Error(`automation_run_finalization_failed:${runUpdateError.message}`);
  }

  return { runId, processed, succeeded, failed, purchaseOrderIds };
}
