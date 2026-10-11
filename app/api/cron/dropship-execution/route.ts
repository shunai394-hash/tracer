import { NextResponse } from "next/server";
import { runAutonomousOrderControl } from "@/lib/ordering/autonomous-control";
import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierCapabilities, listSupplierAdapters } from "@/lib/procurement/registry";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncBaseOrdersToTracer } from "@/lib/channels/base-orders";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    initializeProcurement();

    // One automated commerce chain: BASE order sync first, then supplier execution.
    // BASE payment confirmation and all existing supplier safety gates remain authoritative.
    const baseSync = await syncBaseOrdersToTracer(50);

    const supportedSuppliers = listSupplierAdapters();
    const supplierCapabilities = supportedSuppliers.map((name) => {
      const capabilities = getSupplierCapabilities(name);
      return {
        name,
        orderPreflight: capabilities.orderPreflight,
        orderCreation: capabilities.orderCreation,
        payment: capabilities.payment,
        liveOrdering: capabilities.liveOrdering,
      };
    });
    const externalLiveOrderCapableSupplierCount = supplierCapabilities.filter((supplier) =>
      supplier.name !== "tracer_internal" && supplier.orderPreflight && supplier.orderCreation &&
      supplier.payment && supplier.liveOrdering,
    ).length;
    const internalVariants = await createSupabaseAdminClient()
      .from("internal_supply_variants")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .eq("orderable", true);
    const internalOrderableVariantCount = internalVariants.error ? null : (internalVariants.count ?? 0);

    const automation = await runAutonomousOrderControl(
      `dropship-cron:${new Date().toISOString().slice(0, 13)}`,
    );

    return NextResponse.json({
      ok: true,
      enabled: true,
      suppliers: supportedSuppliers,
      supplierCapabilities,
      supplierReadiness: {
        externalLiveOrderCapableSupplierCount,
        internalOrderableVariantCount,
        internalOrderableVariantQueryOk: !internalVariants.error,
      },
      baseSync,
      attempted: automation.processed,
      succeeded: automation.succeeded,
      failed: automation.failed,
      automationRunId: automation.runId,
      purchaseOrderIds: automation.purchaseOrderIds,
    });
  } catch (error) {
    console.error("[TRACER DROPSHIP EXECUTION CRON ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
