import { NextResponse } from "next/server";
import { requireAutomationCapability } from "@/lib/security/cron-auth";
import { syncPaidShopifyOrders } from "@/lib/shopify/sync-orders";
import { runAutonomousOrderControl } from "@/lib/ordering/autonomous-control";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = await requireAutomationCapability(request, "supplier_order");
  if (authError) return authError;

  try {
    const imported = await syncPaidShopifyOrders(25);
    // Always run the idempotent control plane, not only when a new Shopify
    // order was imported. A prior run may have failed after ingestion, leaving
    // a paid local order awaiting PO creation/execution on the next cron tick.
    const automation = await runAutonomousOrderControl(
      `shopify-orders:${new Date().toISOString().slice(0, 16)}`,
    );

    return NextResponse.json({
      ok: true,
      phase: "shopify_order_ingestion",
      imported,
      automation,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        phase: "shopify_order_ingestion",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
