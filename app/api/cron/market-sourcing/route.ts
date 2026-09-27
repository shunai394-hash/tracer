import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { isCronAuthorized } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Production sourcing cycle:
 * 1) observe the current marketplace
 * 2) investigate only verified supplier-search candidates
 * 3) publish only candidates that pass the sourcing/profit gates
 * 4) promote newly published listings to NEWFIND
 *
 * BASE publication is intentionally a separate idempotent cron so a slow
 * sourcing run cannot prevent already-published TRACER listings from reaching
 * BASE.
 *
 * One bounded supplier batch is intentional: CJ requests are serialized and
 * the Vercel function has a finite execution window.
 */
export async function GET(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const startedAt = Date.now();
    const observation = await persistMarketplaceBestsellers();
    const candidateIds = observation.supplierCandidateIds.slice(
      0,
      BESTSELLER_CANDIDATE_BATCH_SIZE,
    );

    const supplierInvestigation =
      await investigateDropshipForBestsellers(candidateIds);
    const decision = await selectAndPublishSalesTests(candidateIds, 3);


    const newfind = await Promise.all(
      decision.publishedListingIds.map((listingId) =>
        promoteShopListingToNewfind(listingId).catch((error) => ({
          configured: true,
          sent: false,
          eventId: `tracer-shop-listing:${listingId}`,
          status: null,
          ackStatus: null,
          detail: error instanceof Error ? error.message : String(error),
        })),
      ),
    );

    return NextResponse.json({
      ok: true,
      phase: "market_to_publication",
      elapsedMs: Date.now() - startedAt,
      observation: {
        itemCount: observation.itemCount,
        inserted: observation.inserted,
        supplierCandidateCount: observation.supplierCandidateIds.length,
        enrichment: observation.enrichment,
      },
      supplierInvestigation,
      decision,
      newfind,
      publication: {
        publishedNow: decision.published,
        existingPublishedListingsPreserved: true,
        candidateBatchSize: candidateIds.length,
        candidateBatchLimited:
          observation.supplierCandidateIds.length > candidateIds.length,
      },
    });
  } catch (error) {
    console.error("[TRACER MARKET SOURCING CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "market_to_publication",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
