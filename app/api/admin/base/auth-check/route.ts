import { NextResponse } from "next/server";
import { isBaseConfigured, listBaseOrders } from "@/lib/channels/base";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * Read-only BASE connectivity probe. It deliberately returns counts and a
 * bounded diagnosis only; order identifiers, customer data and credentials
 * are never included in the response.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const configured = isBaseConfigured();
  if (!configured) {
    return NextResponse.json(
      { ok: false, channel: "base", configured: false, diagnosis: "base_credentials_missing" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const orders = await listBaseOrders({ limit: 1 });
    return NextResponse.json({
      ok: true,
      channel: "base",
      configured: true,
      authentication: "accepted",
      probe: "orders_list_read_only",
      sampleCount: orders.length,
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/HTTP (\\d{3})/)?.[1] ?? 0) || null;
    const diagnosis = status === 400 || status === 401
      ? "base_access_token_rejected_or_invalid_scope"
      : status === 403
        ? "base_permission_denied"
        : status === 429
          ? "base_rate_limited"
          : status === null
            ? "base_network_or_configuration_error"
            : "base_api_request_failed";
    return NextResponse.json({
      ok: false,
      channel: "base",
      configured: true,
      authentication: "not_confirmed",
      status,
      diagnosis,
      checkedAt: new Date().toISOString(),
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
