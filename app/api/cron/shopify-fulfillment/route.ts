import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncShopifyFulfillments } from "@/lib/shopify/sync-fulfillments";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const result = await syncShopifyFulfillments(25);
    return NextResponse.json({ ok: true, phase: "shopify_fulfillment_sync", ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, phase: "shopify_fulfillment_sync", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
