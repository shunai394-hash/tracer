import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { listBaseOrders, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";

/** Read-only OAuth/API probe. Never returns order IDs, customer data, or credentials. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    if (!isBaseConfigured()) {
      console.info("[TRACER BASE AUTH PROBE]", { configured: false, apiStatus: null, orderCountReturned: null });
      return NextResponse.json(
        { ok: false, configured: false, baseApi: false, apiStatus: null, error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const orders = await listBaseOrders({ limit: 1 });
    const dispatchStatuses = [...new Set(orders.map((order) => String(order.dispatch_status ?? "unknown")))].sort();
    const result = {
      ok: true,
      configured: true,
      baseApi: true,
      apiStatus: 200,
      orderCountReturned: orders.length,
      dispatchStatuses,
    };
    console.info("[TRACER BASE AUTH PROBE]", result);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_DIAGNOSTIC_FAILED";
    const status = Number(message.match(/HTTP_(\d{3})/)?.[1] ?? 0) || null;
    const stage = message.split(":")[0].slice(0, 100);
    console.error("[TRACER BASE AUTH PROBE FAILED]", { stage, status });
    return NextResponse.json(
      { ok: false, configured: true, baseApi: false, apiStatus: status, error: stage },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
