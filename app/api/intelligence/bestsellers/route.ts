import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST() {
  try {
    const startedAt = Date.now();

    // Supply-first is now the primary path: a real CJ product with live
    // variant/stock/freight evidence can become a TRACER-owned listing without
    // pretending that it is identical to a marketplace product.
    const supplyFirst = await discoverAndCreateCjSupply(1);

    if (supplyFirst.published > 0) {
      const base = await publishPublishedListingsToBase(5);
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
        mode: "supply_first",
        supplyFirst,
        base,
        newfind,
        salesReady: base.published > 0,
      });
    }

    // Keep the existing market-linked pipeline as the fallback when the
    // supply-first source has no publishable candidate.
    const bestsellers = await persistMarketplaceBestsellers();
    const candidateIds = bestsellers.supplierCandidateIds.slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE);
    const suppliers = await investigateDropshipForBestsellers(candidateIds);
    const selected = await selectAndPublishSalesTests(candidateIds, 5);
    const base = await publishPublishedListingsToBase(5);
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
      mode: "market_linked_fallback",
      supplyFirst,
      bestsellers,
      suppliers,
      selected,
      base,
      newfind,
      salesReady: selected.published > 0 || base.published > 0,
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
