import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";
import { previewShopifySync } from "@/lib/shopify/sync-published-listings";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json().catch(() => ({}))) as { listingIds?: unknown; dryRun?: unknown; limit?: unknown };
    // dryRun: report exactly what the next sync would write (no Shopify or DB writes).
    if (body.dryRun === true) {
      const limit = Number(body.limit);
      const preview = await previewShopifySync(Number.isFinite(limit) && limit > 0 ? limit : 150);
      return NextResponse.json({ ok: true, dryRun: true, ...preview });
    }
    const listingIds = Array.isArray(body.listingIds)
      ? body.listingIds.map(String).filter(Boolean).slice(0, 15)
      : undefined;

    const rawSyncLimit = Number(body.limit);
    const syncLimit = Number.isFinite(rawSyncLimit) && rawSyncLimit > 0 ? Math.min(15, Math.floor(rawSyncLimit)) : 10;
    const result = await syncPublishedListingsToShopify(listingIds, syncLimit);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
