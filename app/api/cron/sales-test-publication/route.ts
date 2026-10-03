import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";

export const runtime = "nodejs";
export const maxDuration = 300;

// NEWFIND delivery for listings this run's Sales Test Gate just published.
// promoteShopListingToNewfind re-checks the gate itself; a failure is
// reported, not thrown, and the pending delivery row is retried by
// /api/cron/newfind-retry.
async function promoteGatePassedListings(listingIds: string[]) {
  const base = await publishPublishedListingsToBase(10, listingIds);
  const baseReady = base.results
    .filter((result) => result.ok && result.baseItemId)
    .map((result) => result.listingId);

  const newfind = await Promise.all(
    baseReady.map((listingId) =>
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

  return { base, baseReady, newfind };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
    await recoverStaleCronRun(supabase, "sales-test-publication", maxDuration);

    const { data: cronRun, error: claimError } = await supabase
      .from("cron_runs")
      .insert({
        job_name: "sales-test-publication",
        status: "running",
        metadata: { phase: "sales_test_publication" },
      })
      .select("id")
      .single();

    if (claimError) {
      if (claimError.code === "23505") {
        return NextResponse.json(
          { ok: true, skipped: true, reason: "cron_already_running", job: "sales-test-publication" },
          { status: 409 },
        );
      }
      throw new Error(claimError.message);
    }

    cronRunId = cronRun?.id ? String(cronRun.id) : null;

    // Customer-facing publication is market/demand-first. Supply-first discovery
    // creates procureable candidates, but without marketplace identity and demand
    // evidence it cannot become TEST_READY. Run the canonical bestseller ->
    // supplier identity investigation first, then rebuild intelligence and apply
    // the single Sales Test Gate.
    const bestsellers = await persistMarketplaceBestsellers();
    const candidateIds = bestsellers.supplierCandidateIds.slice(0, 5).map(String);
    const suppliers = await investigateDropshipForBestsellers(candidateIds);

    await buildOpportunityIntelligence();

    const decision = await selectAndPublishSalesTests(candidateIds, 5);
    const downstream = await promoteGatePassedListings(decision.publishedListingIds);

    if (cronRunId) {
      await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: candidateIds.length,
        failed: 0,
        metadata: {
          phase: "sales_test_publication",
          mode: "market_linked_sales_test",
          supplierProcessed: suppliers.processed,
          supplierMatched: suppliers.matched,
          supplierNoIdentifierOverlap: suppliers.noIdentifierOverlap,
          considered: decision.considered,
          published: decision.published,
        },
      }).eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: true,
      phase: "sales_test_publication",
      elapsedMs: Date.now() - startedAt,
      mode: "market_linked_sales_test",
      candidateCount: candidateIds.length,
      bestsellers,
      suppliers,
      decision,
      downstream,
      nextPhase: "downstream_delivery",
    });
  } catch (error) {
    if (cronRunId) {
      try {
        await supabase.from("cron_runs").update({
          status: "failed",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }).eq("id", cronRunId);
      } catch (recordError) {
        console.error("[TRACER CRON RUN RECORD ERROR]", recordError);
      }
    }

    console.error("[TRACER SALES TEST PUBLICATION CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "sales_test_publication",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
