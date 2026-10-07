import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();

    // 1. Persist demand candidates.
    const bestsellers = await persistMarketplaceBestsellers();
    const candidateIds = bestsellers.supplierCandidateIds
      .slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE)
      .filter(Boolean);

    // 2. Resolve supplier evidence for those demand candidates.
    const suppliers = await investigateDropshipForBestsellers(candidateIds);

    // 3. Build canonical opportunity intelligence from persisted demand/supply
    // evidence. No manual opportunity row is created here.
    const opportunity = await buildOpportunityIntelligence();

    // 4. The only publication path is the canonical Sales Test Gate.
    const selected = await selectAndPublishSalesTests(candidateIds, 5);

    // 5. NEWFIND receives only listings that actually passed the Sales Test Gate.
    const shopify = await syncPublishedListingsToShopify(selected.selectedListingIds);
    const newfind = await Promise.all(
      shopify.listingIds.map((listingId) =>
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
      mode: "canonical_demand_opportunity_sales_test",
      bestsellers,
      suppliers,
      opportunity,
      selected,
      shopify,
      newfind,
      salesReady: shopify.listingIds.length > 0,
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
