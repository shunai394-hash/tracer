import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    const startedAt = Date.now();
    const bestsellers = await persistMarketplaceBestsellers();
    const suppliers = await investigateDropshipForBestsellers(bestsellers.bestsellerIds);
    const selected = await selectAndPublishSalesTests(bestsellers.bestsellerIds, 3);
    const newfind = await Promise.all(
      selected.publishedListingIds.map((listingId) =>
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
      bestsellers,
      suppliers,
      selected,
      newfind,
      salesReady: selected.published > 0,
    });
  } catch (error) {
    console.error("[TRACER BESTSELLERS ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
