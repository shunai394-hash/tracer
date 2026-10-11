import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { listBaseOrders, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

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
      orderReadSucceeded: true,
      orderCountReturned: orders.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BASE_DIAGNOSTIC_FAILED";
    console.error("[TRACER BASE DIAGNOSTIC ERROR]", {
      stage: message.split(":")[0],
      status: message.match(/HTTP_(\\d{3})/)?.[1] ?? null,
    });

    return NextResponse.json(
      {
        ok: false,
        configured: true,
        baseApi: false,
        error: error instanceof Error ? error.message.slice(0, 240) : "BASE_DIAGNOSTIC_FAILED",
      },
      { status: 500 },
    );
  }
}
