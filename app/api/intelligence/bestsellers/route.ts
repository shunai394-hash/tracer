import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();

    // Supply discovery is never a publication path. Evaluate its canonical
    // product/offer/intelligence rows through the same opportunity gate first.
    const supplyFirst = await discoverAndCreateCjSupply(50);
    await buildOpportunityIntelligence();
    const supplySelected = await selectAndPublishSupplySalesTests(
      supplyFirst.items.map((item) => String(item.productId ?? "")).filter(Boolean),
      5,
    );
    const supplyNewfind = await Promise.all(
      supplySelected.publishedListingIds.map((listingId) =>
        promoteShopListingToNewfind(listingId).catch((error) => ({
          configured: true,
          sent: false,
          eventId: `tracer-shop-listing:${listingId}`,
          status: null,
          detail: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    if (supplySelected.published > 0) {
      const base = await publishPublishedListingsToBase(50);
      return NextResponse.json({
        ok: true,
        elapsedMs: Date.now() - startedAt,
        mode: "supply_first",
        supplyFirst,
        supplySelected,
        base,
        newfind: supplyNewfind,
        salesReady: true,
      });
    }

    // Keep the existing market-linked pipeline as the fallback when the
    // supply-first source has no publishable candidate.
    const bestsellers = await persistMarketplaceBestsellers();
    const candidateIds = bestsellers.supplierCandidateIds.slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE);
    const suppliers = await investigateDropshipForBestsellers(candidateIds);
    const selected = await selectAndPublishSalesTests(candidateIds, 5);
    // NEWFIND re-checks the Sales Test Gate per listing; BASE creation is left
    // to the base-publish stage, which applies the same gate.
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
      mode: "market_linked_sales_test",
      supplyFirst,
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
