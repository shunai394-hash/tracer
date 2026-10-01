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

  // The automation audit tables are operational telemetry, not a prerequisite
  // for creating or executing a supplier order. A stale/missing Supabase grant
  // must not turn a paid customer order into a silently unprocessed order.
  let auditPersistence = true;
  let existingRun: { data: { id?: string; status?: string; processed_count?: number; succeeded_count?: number; failed_count?: number } | null; error?: { code?: string; message?: string } | null };

  const existingRunQuery = await supabase
    .from("order_automation_runs")
    .select("id,status,processed_count,succeeded_count,failed_count")
    .eq("run_key", runKey)
    .maybeSingle();

  if (existingRunQuery.error) {
    if (existingRunQuery.error.code === "42501" || existingRunQuery.error.code === "42P01") {
      auditPersistence = false;
      existingRun = { data: null, error: existingRunQuery.error };
      console.warn("[TRACER AUTOMATION AUDIT DEGRADED]", existingRunQuery.error.message);
    } else {
      throw new Error(existingRunQuery.error.message);
    }
  } else {
    existingRun = existingRunQuery;
  }

  if (auditPersistence && existingRun.data?.status === "completed") {
    return {
      runId: String(existingRun.data.id),
      processed: Number(existingRun.data.processed_count ?? 0),
      succeeded: Number(existingRun.data.succeeded_count ?? 0),
      failed: Number(existingRun.data.failed_count ?? 0),
      purchaseOrderIds: [],
    };
  }

  const run = auditPersistence
    ? existingRun.data?.id
      ? { id: String(existingRun.data.id) }
      : await (async () => {
          const inserted = await supabase
            .from("order_automation_runs")
            .insert({ run_key: runKey, mode: "scheduled", status: "running" })
            .select("id")
            .single();
          if (inserted.error) {
            if (inserted.error.code === "23505") {
              const retry = await supabase
                .from("order_automation_runs")
                .select("id")
                .eq("run_key", runKey)
                .single();
              if (!retry.data) throw new Error(retry.error?.message ?? "automation run claim failed");
              return { id: String(retry.data.id) };
            }
            if (inserted.error.code === "42501" || inserted.error.code === "42P01") {
              auditPersistence = false;
              console.warn("[TRACER AUTOMATION AUDIT DEGRADED]", inserted.error.message);
              return { id: `degraded:${runKey}` };
            }
            throw new Error(inserted.error.message);
          }
          return { id: String(inserted.data.id) };
        })()
    : { id: `degraded:${runKey}` };

  const { data: orders, error } = await supabase
    .from("shop_orders")
    .select("id,payment_status,order_status")
    .eq("payment_status", "paid")
    .in("order_status", ["placed", "processing", "fulfilled"])
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

  if (auditPersistence) {
    const { error: runUpdateError } = await supabase
      .from("order_automation_runs")
      .update({
        status: failed > 0 && succeeded === 0 ? "failed" : "completed",
        finished_at: new Date().toISOString(),
        processed_count: processed,
        succeeded_count: succeeded,
        failed_count: failed,
      })
      .eq("id", run.id);

    if (runUpdateError && runUpdateError.code !== "42501" && runUpdateError.code !== "42P01") {
      throw new Error(runUpdateError.message);
    }
    if (runUpdateError) {
      console.warn("[TRACER AUTOMATION AUDIT UPDATE SKIPPED]", runUpdateError.message);
    }
  }

  return { runId: run.id, processed, succeeded, failed, purchaseOrderIds };
}
