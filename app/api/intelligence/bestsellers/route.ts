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
    const url = new URL(request.url);
    const parseCursor = (key: string, fallback: number) => {
      const raw = url.searchParams.get(key);
      if (raw === null || raw.trim() === "") return fallback;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid_${key}`);
      return value;
    };
    // A bounded, resumable intake page. Run six 200-item pages to process a
    // 1,200-item target without turning one serverless invocation into a
    // single oversized request. Publication gates remain unchanged.
    const startIndex = parseCursor("startIndex", 0);
    const sourceIndex = parseCursor("sourceIndex", 0);
    const requestedBatchSize = parseCursor("batchSize", BESTSELLER_CANDIDATE_BATCH_SIZE);
    const batchSize = Math.min(BESTSELLER_CANDIDATE_BATCH_SIZE, Math.max(1, requestedBatchSize));

    // 1. Persist one bounded page of demand candidates.
    const bestsellers = await persistMarketplaceBestsellers({ startIndex, batchSize, sourceIndex });
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
      intake: {
        requestedTarget: 1200,
        pageSize: batchSize,
        startIndex: bestsellers.startIndex,
        sourceIndex: bestsellers.sourceIndex,
        nextStartIndex: bestsellers.nextIndex,
        nextSourceIndex: bestsellers.sourceIndex,
        hasMore: bestsellers.hasMore,
        suggestedNextUrl: bestsellers.hasMore
          ? `/api/intelligence/bestsellers?startIndex=${bestsellers.nextIndex}&sourceIndex=${bestsellers.sourceIndex}&batchSize=${batchSize}`
          : null,
        note: "Intake persistence is separate from public sale; only listings that pass the existing sales and fulfillment gates can be published.",
      },
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
