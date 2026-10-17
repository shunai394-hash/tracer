import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncCommerceListings } from "@/lib/commerce/publish";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const requested = Number(new URL(request.url).searchParams.get("limit") || 5);
    // Reprocess published rows so recalculated 50% margin prices reach the storefront.
    // Keep scheduled work small to reduce function timeouts while still refreshing published prices.
    const limit = Number.isFinite(requested) ? Math.min(10, Math.max(1, Math.floor(requested))) : 5;
    const onlyUnpublished = new URL(request.url).searchParams.get("onlyUnpublished") === "true";
    const result = await syncCommerceListings("shopify", limit, onlyUnpublished);
    return NextResponse.json({ ok: result.failed === 0, ...result }, { status: result.failed ? 207 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, channel: "shopify", error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
