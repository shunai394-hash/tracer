import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();

    // This route is the demand/market path. Supplier-only discovery belongs
    // to /api/cron/supply-first and must not consume this short 60s window.
    // Here we need marketplace evidence -> supplier identity -> intelligence ->
    // Sales Test Gate, because that is the only route that can create a
    // customer-facing listing without weakening identity or demand checks.
    const bestsellers = await persistMarketplaceBestsellers();
    const candidateIds = bestsellers.supplierCandidateIds
      .slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE);
    const suppliers = await investigateDropshipForBestsellers(candidateIds);
    await buildOpportunityIntelligence();

    const selected = await selectAndPublishSalesTests(candidateIds, 5);
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
