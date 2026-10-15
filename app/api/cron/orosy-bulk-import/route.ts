import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * Orosy was explicitly removed from TRACER's supplier scope.
 * Keep this route as a closed endpoint so existing cron invocations cannot
 * continue importing products or creating supplier records.
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
