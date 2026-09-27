import { NextResponse } from "next/server";
import { syncSupplierOrders } from "@/lib/procurement/sync-orders";
import { isCronAuthorized } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  return isCronAuthorized(request);
}

export async function GET(request: Request) {
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
