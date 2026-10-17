import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncPaidShopifyOrders } from "@/lib/shopify/sync-orders";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) {
    console.warn("[TRACER SHOPIFY ORDER POLL AUTH REJECTED]", { status: authError.status });
    return authError;
  }

  try {
    const imported = await syncPaidShopifyOrders(25);
    console.info("[TRACER SHOPIFY ORDER POLL]", {
      ok: imported.failed === 0, configured: imported.configured, fetched: imported.fetched,
      imported: imported.imported, skipped: imported.skipped, failed: imported.failed,
      errorCategories: imported.errors.map((item) => item.error.split(":")[0]).slice(0, 10),
    });
    return NextResponse.json({
      ok: imported.failed === 0,
      phase: "canonical_shopify_order_ingestion",
      imported,
      procurement: "canonical commerce-procurement cron owns supplier submission",
    }, { status: imported.failed ? 207 : 200 });
  } catch (error) {
    console.error("[TRACER SHOPIFY ORDER POLL FAILED]", {
      error: error instanceof Error ? error.message : String(error),
    });
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
