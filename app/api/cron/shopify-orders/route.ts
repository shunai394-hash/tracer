import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncPaidShopifyOrders } from "@/lib/shopify/sync-orders";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const imported = await syncPaidShopifyOrders(25);
    return NextResponse.json({
      ok: imported.failed === 0,
      phase: "canonical_shopify_order_ingestion",
      imported,
      procurement: "canonical commerce-procurement cron owns supplier submission",
    }, { status: imported.failed ? 207 : 200 });
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
