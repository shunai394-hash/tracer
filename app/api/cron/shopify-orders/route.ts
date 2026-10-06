import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncPaidShopifyOrders } from "@/lib/shopify/sync-orders";
import { runAutonomousOrderControl } from "@/lib/ordering/autonomous-control";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const imported = await syncPaidShopifyOrders(25);
    const automation = imported.imported > 0
      ? await runAutonomousOrderControl(`shopify-orders:${new Date().toISOString().slice(0, 13)}`)
      : null;

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
