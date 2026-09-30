import { NextResponse } from "next/server";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();
    const supplyFirst = await discoverAndCreateCjSupply(50);
    const base = await publishPublishedListingsToBase(
      Math.max(5, supplyFirst.items.length),
    );

    const listingIds = supplyFirst.items
      .map((item) => String(item.listingId ?? ""))
      .filter(Boolean);

    const newfind = await Promise.all(
      listingIds.map((listingId) =>
        promoteShopListingToNewfind(listingId).catch((error) => ({
          configured: true,
          sent: false,
          eventId: `tracer-shop-listing:${listingId}`,
          status: null,
          detail: error instanceof Error ? error.message : String(error),
        })),
      ),
    );

    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      supplyFirst,
      base,
      newfind,
    });
  } catch (error) {
    console.error("[TRACER SUPPLY-FIRST CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
