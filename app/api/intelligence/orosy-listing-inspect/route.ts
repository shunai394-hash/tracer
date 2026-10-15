import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";

/** Orosy listing inspection is disabled with the supplier integration. */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  return NextResponse.json({
    ok: false,
    disabled: true,
    reason: "supplier_disabled_by_product_decision",
    supplier: "orosy",
  }, { status: 410 });
}
