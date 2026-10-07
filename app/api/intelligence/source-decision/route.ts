import { NextRequest, NextResponse } from "next/server";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sourcing decision only.
 * Input is an observed marketplace bestseller batch. This endpoint is the
 * explicit boundary where TRACER asks: "Can we actually source and sell it?"
 */
export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const bestsellerIds = Array.isArray(body?.bestsellerIds)
      ? body.bestsellerIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
      : [];

    if (bestsellerIds.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          phase: "sourcing_decision",
          error: "bestsellerIds_required",
          detail: "Run /api/intelligence/market-observe first and pass its observation.bestsellerIds.",
        },
        { status: 400 },
      );
    }

    const startedAt = Date.now();
    // Bound the supplier investigation so serialized CJ calls cannot consume
    // the entire serverless execution window before publication runs.
    const candidatePool = Array.isArray(body?.supplierCandidateIds)
      ? body.supplierCandidateIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
      : bestsellerIds;
    const offset = Number.isInteger(body?.offset) && body.offset >= 0 ? body.offset : 0;
    const candidateIds = candidatePool.slice(offset, offset + BESTSELLER_CANDIDATE_BATCH_SIZE);
    const suppliers = await investigateDropshipForBestsellers(candidateIds);
    // This endpoint can be invoked independently of the scheduled pipeline.
    // Rebuild the authoritative Opportunity Intelligence snapshot before the
    // publication gate so a stale/missing intelligence row can never be used
    // as a reason to publish.
    const opportunity = await buildOpportunityIntelligence();
    const selected = await selectAndPublishSalesTests(candidateIds, 3);

    const shopify = await syncPublishedListingsToShopify(selected.selectedListingIds);
    const newfind = await Promise.all(
      shopify.listingIds.map((listingId) =>
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
      phase: "sourcing_decision",
      elapsedMs: Date.now() - startedAt,
      supplierInvestigation: suppliers,
      decision: selected,
      shopify,
      newfind,
      publication: {
        publishedNow: shopify.listingIds.length,
        existingPublishedListingsPreserved: true,
        candidateBatchSize: candidateIds.length,
        candidateBatchLimited: candidatePool.length > candidateIds.length,
        observedBestsellerCount: bestsellerIds.length,
        supplierCandidateCount: candidatePool.length,
        candidateOffset: offset,
        nextCandidateOffset:
          offset + candidateIds.length < candidatePool.length
            ? offset + candidateIds.length
            : null,
      },
    });
  } catch (error) {
    console.error("[TRACER SOURCING DECISION ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "sourcing_decision",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
