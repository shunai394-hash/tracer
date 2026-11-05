import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getBaseShopIdentity, isBaseConfigured, listBaseOrders } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * Read-only BASE orders API diagnostic.
 * Deliberately omits date filters and never reads order details, customer data,
 * writes to Supabase, imports orders, or triggers procurement.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  if (!isBaseConfigured()) {
    return NextResponse.json({
      ok: false, readOnly: true, configured: false,
      error: "BASE_OAUTH_CONFIG_INCOMPLETE",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const [shopIdentity, first, second] = await Promise.all([
      getBaseShopIdentity(),
      listBaseOrders({ limit: 100, offset: 0 }),
      listBaseOrders({ limit: 100, offset: 100 }),
    ]);
    const orders = [...first, ...second];
    const dispatchStatuses: Record<string, number> = {};
    for (const order of orders) {
      const status = typeof order.dispatch_status === "string" && order.dispatch_status
        ? order.dispatch_status : "unknown";
      dispatchStatuses[status] = (dispatchStatuses[status] ?? 0) + 1;
    }
    return NextResponse.json({
      ok: true,
      readOnly: true,
      configured: true,
      shop: shopIdentity,
      dateFilter: null,
      pages: [
        { offset: 0, returned: first.length },
        { offset: 100, returned: second.length },
      ],
      totalReturned: orders.length,
      dispatchStatuses,
      checkedAt: new Date().toISOString(),
      privacy: "No order IDs, customer details, order payloads, or credentials returned.",
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeCode = message.split(":")[0].replace(/[^A-Z0-9_]/gi, "").slice(0, 100) || "BASE_ORDERS_PROBE_FAILED";
    const statusMatch = message.match(/HTTP_(\d{3})/);
    return NextResponse.json({
      ok: false,
      readOnly: true,
      configured: true,
      error: safeCode,
      upstreamStatus: statusMatch ? Number(statusMatch[1]) : null,
      checkedAt: new Date().toISOString(),
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
