import { NextResponse } from "next/server";
import { syncBaseOrdersToTracer } from "@/lib/channels/base-orders";
import { requireAutomationCapability } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationCapability(request, "internal_fulfillment");
  if (authError) return authError;

  try {
    const result = await syncBaseOrdersToTracer(50);
    return NextResponse.json({ ok: true, channel: "base", ...result });
  } catch (error) {
    console.error("[TRACER BASE ORDER SYNC ERROR]", error);
    return NextResponse.json(
      { ok: false, channel: "base", error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
