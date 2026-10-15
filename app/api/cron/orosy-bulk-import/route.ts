import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * Orosy is outside TRACER's approved supplier scope.
 * Keep the cron endpoint closed so scheduled invocations cannot import
 * products, create supplier records, or indirectly enable listings.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  return NextResponse.json(
    {
      ok: false,
      disabled: true,
      reason: "supplier_disabled_by_product_decision",
      supplier: "orosy",
    },
    { status: 410 },
  );
}
