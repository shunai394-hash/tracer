import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const body = (await request.json().catch(() => ({}))) as { listingIds?: unknown };
    const listingIds = Array.isArray(body.listingIds)
      ? body.listingIds.map(String).filter(Boolean).slice(0, 100)
      : undefined;

    const result = await syncPublishedListingsToShopify(listingIds);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
