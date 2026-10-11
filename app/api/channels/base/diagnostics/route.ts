import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { probeBaseReadOnly, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";

/** Read-only OAuth/API probe. Never returns item IDs, order IDs, customer data, or credentials. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    if (!isBaseConfigured()) {
      console.info("[TRACER BASE AUTH PROBE]", {
        configured: false, ordersApiStatus: null, itemsApiStatus: null,
      });
      return NextResponse.json(
        { ok: false, configured: false, baseApi: false, ordersApiStatus: null, itemsApiStatus: null, error: "BASE_OAUTH_CONFIG_INCOMPLETE" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const probe = await probeBaseReadOnly({ itemPageLimit: 100, itemMaxPages: 10 });
    const result = {
      ok: probe.orders.apiStatus === 200 && probe.items.apiStatus === 200 && probe.items.errorStage === null,
      configured: true,
      baseApi: probe.orders.apiStatus === 200,
      ordersApiStatus: probe.orders.apiStatus,
      orderCountReturned: probe.orders.countReturned,
      dispatchStatuses: probe.orders.dispatchStatuses,
      itemsApi: probe.items.apiStatus === 200,
      itemsApiStatus: probe.items.apiStatus,
      itemCountReturned: probe.items.countReturned,
      visibleItemsReturned: probe.items.visibleCount,
      hiddenItemsReturned: probe.items.hiddenCount,
      unknownVisibilityCount: probe.items.unknownVisibilityCount,
      itemPages: probe.items.pages,
      itemAuditComplete: probe.items.complete,
      itemErrorStage: probe.items.errorStage,
    };
    console.info("[TRACER BASE AUTH PROBE]", result);
    // HTTP 200 means the diagnostic ran. ok:false records a failed items-read capability
    // without masking a successful orders probe.
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_DIAGNOSTIC_FAILED";
    const status = Number(message.match(/HTTP_(\d{3})/)?.[1] ?? 0) || null;
    const stage = message.split(":")[0].slice(0, 100);
    console.error("[TRACER BASE AUTH PROBE FAILED]", { stage, status });
    return NextResponse.json(
      { ok: false, configured: true, baseApi: false, ordersApiStatus: status, error: stage },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
