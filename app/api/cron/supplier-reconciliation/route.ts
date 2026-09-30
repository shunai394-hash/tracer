import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { reconcileSupplierOrders } from "@/lib/ordering/reconcile";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const result = await reconcileSupplierOrders(50);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[TRACER SUPPLIER RECONCILIATION CRON ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
