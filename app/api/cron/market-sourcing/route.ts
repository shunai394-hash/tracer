import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { requireCronAuth } from "@/lib/security/cron-auth";

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
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();
    const observation = await persistMarketplaceBestsellers();

    // The marketplace scrape is only the intake. Existing DB candidates must
    // also be drained; otherwise a catalog such as the existing 4,555-row
    // backlog can remain permanently untouched between fresh scrapes.
    const supabase = (await import("@/lib/supabase/admin")).createSupabaseAdminClient();
    const { data: backlogRows, error: backlogError } = await supabase
      .from("marketplace_bestsellers")
      .select("id")
      .in("pipeline_status", ["pending", "failed"])
      .or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null,mpn.not.is.null")
      .order("fetched_at", { ascending: true })
      .limit(BESTSELLER_CANDIDATE_BATCH_SIZE);

    if (backlogError) throw new Error(backlogError.message);

    let backlogIds = (backlogRows ?? []).map((row) => String(row.id));

    // Supplier mismatches can be transient. Once the pending/failed queue is
    // exhausted, re-check blocked identifier-bearing candidates after a
    // cooldown instead of leaving them permanently stranded.
    if (backlogIds.length < BESTSELLER_CANDIDATE_BATCH_SIZE) {
      const retrySlots = BESTSELLER_CANDIDATE_BATCH_SIZE - backlogIds.length;
      const retryBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: retryRows, error: retryError } = await supabase
        .from("marketplace_bestsellers")
        .select("id")
        .eq("pipeline_status", "blocked")
        .lt("pipeline_updated_at", retryBefore)
        .or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null,mpn.not.is.null")
        .order("pipeline_updated_at", { ascending: true })
        .limit(retrySlots);

      if (retryError) throw new Error(retryError.message);

      backlogIds = [
        ...backlogIds,
        ...(retryRows ?? []).map((row) => String(row.id)),
      ];
    }
    const freshIds = observation.supplierCandidateIds;
    const candidateIds = [...backlogIds, ...freshIds]
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE);

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
        backlogCandidateCount: backlogIds.length,
        enrichment: observation.enrichment,
      },
      supplierInvestigation,
      decision,
      newfind,
      publication: {
        publishedNow: decision.published,
        existingPublishedListingsPreserved: true,
        candidateBatchSize: candidateIds.length,
        backlogDraining: backlogIds.length > 0,
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
