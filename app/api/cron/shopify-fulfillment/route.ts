import { NextResponse } from "next/server";
import { requireAutomationCapability } from "@/lib/security/cron-auth";
import { syncShopifyFulfillments } from "@/lib/shopify/sync-fulfillments";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationCapability(request, "channel_write");
  if (authError) return authError;

  try {
    const result = await syncShopifyFulfillments(25);
    const blocked = Boolean(result.blockers?.length);
    return NextResponse.json(
      { ok: !blocked, phase: "shopify_fulfillment_sync", ...result },
      { status: blocked ? 409 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, phase: "shopify_fulfillment_sync", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
