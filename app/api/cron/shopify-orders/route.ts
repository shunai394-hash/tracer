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
    // Retry the control plane even when no new order was imported. Use a
    // per-invocation key: an hourly key would return the prior completed run
    // and silently skip retries on subsequent polls in the same hour.
    const invocationId =
      request.headers.get("x-vercel-id") ?? crypto.randomUUID();
    const automation = await runAutonomousOrderControl(
      `shopify-orders:${invocationId}`,
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
