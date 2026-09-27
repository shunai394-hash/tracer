import { NextRequest, NextResponse } from "next/server";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sourcing decision only.
 * Input is an observed marketplace bestseller batch. This endpoint is the
 * explicit boundary where TRACER asks: "Can we actually source and sell it?"
 */
export async function POST(request: NextRequest) {
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
    const suppliers = await investigateDropshipForBestsellers(bestsellerIds);
    const selected = await selectAndPublishSalesTests(bestsellerIds, 3);

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
