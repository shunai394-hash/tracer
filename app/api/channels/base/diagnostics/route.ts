import { NextResponse } from "next/server";
import { listBaseOrders, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    if (!isBaseConfigured()) {
      return NextResponse.json(
        { ok: false, configured: false, error: "BASE is not configured" },
        { status: 503 },
      );
    }

    const orders = await listBaseOrders({ limit: 1 });

    return NextResponse.json({
      ok: true,
      configured: true,
      baseApi: true,
      orderCountReturned: orders.length,
      orders: orders.map((order) => ({
        unique_key: order.unique_key,
        dispatch_status: order.dispatch_status,
        ordered: order.ordered,
      })),
    });
  } catch (error) {
    console.error("[TRACER BASE DIAGNOSTIC ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        configured: true,
        baseApi: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
