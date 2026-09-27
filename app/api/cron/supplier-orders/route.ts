import { NextResponse } from "next/server";
import { syncSupplierOrders } from "@/lib/procurement/sync-orders";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncSupplierOrders();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[TRACER SUPPLIER ORDER SYNC ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
