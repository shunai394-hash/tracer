import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync-published-listings";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const result = await syncPublishedListingsToShopify(10);
    return NextResponse.json({
      ok: true,
      phase: "shopify_channel_sync",
      ...result,
      note: "Only TRACER Sales Test Gate-passed PUBLISHED listings are synchronized.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        phase: "shopify_channel_sync",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
