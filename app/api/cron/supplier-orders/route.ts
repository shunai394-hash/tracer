import { NextResponse } from "next/server";
import { syncSupplierOrders } from "@/lib/procurement/sync-orders";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  return !cronSecret || request.headers.get("authorization") === `Bearer ${cronSecret}`;
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
