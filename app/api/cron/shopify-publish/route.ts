import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { isShopifyConfigured } from "@/lib/shopify/admin";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync-published-listings";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  if (!isShopifyConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        phase: "shopify_channel_sync",
        configured: false,
        error: "SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN is not configured",
      },
      { status: 503 },
    );
  }

  try {
    const result = await syncPublishedListingsToShopify(10);
    return NextResponse.json({
      ok: result.failed === 0,
      phase: "shopify_channel_sync",
      ...result,
      note: "Only TRACER Sales Test Gate-passed PUBLISHED listings are synchronized.",
    }, { status: result.failed === 0 ? 200 : 207 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, phase: "shopify_channel_sync", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
