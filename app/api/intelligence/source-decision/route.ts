import { NextRequest, NextResponse } from "next/server";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
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
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = request.headers.get("authorization");
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
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
    const selected = await selectAndPublishSalesTests(candidateIds, 3);

    const newfind = await Promise.all(
      selected.publishedListingIds.map((listingId) =>
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
      newfind,
      publication: {
        publishedNow: selected.published,
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
