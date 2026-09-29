import { NextResponse } from "next/server";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;

  try {
    const startedAt = Date.now();

    await supabase
      .from("cron_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: "stale_run_reclaimed",
      })
      .eq("job_name", "market-sourcing")
      .eq("status", "running")
      .lt("started_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

    const { data: cronRun, error: cronClaimError } = await supabase
      .from("cron_runs")
      .insert({ job_name: "market-sourcing", status: "running", metadata: {} })
      .select("id")
      .single();

    if (cronClaimError) {
      if (cronClaimError.code === "23505") {
        return NextResponse.json(
          { ok: true, skipped: true, reason: "cron_already_running", job: "market-sourcing" },
          { status: 409 },
        );
      }
      throw new Error(cronClaimError.message);
    }

    cronRunId = cronRun?.id ? String(cronRun.id) : null;

    const observation = await persistMarketplaceBestsellers();

    const { data: backlogRows, error: backlogError } = await supabase
      .from("marketplace_bestsellers")
      .select("id")
      .in("pipeline_status", ["pending", "failed"])
      .or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null,mpn.not.is.null")
      .order("fetched_at", { ascending: true })
      .limit(BESTSELLER_CANDIDATE_BATCH_SIZE);

    if (backlogError) throw new Error(backlogError.message);

    let backlogIds = (backlogRows ?? []).map((row) => String(row.id));

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
    // Always give the current market observation first claim on the batch.
    // Otherwise an old pending backlog can permanently starve newly discovered
    // products because the backlog is larger than the per-run investigation cap.
    const candidateIds = [...freshIds, ...backlogIds]
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

    if (cronRunId) {
      await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: candidateIds.length,
        failed: 0,
        metadata: { published: decision.published, newfind: newfind.length },
      }).eq("id", cronRunId);
    }

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
    if (cronRunId) {
      try {
        await supabase.from("cron_runs").update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }).eq("id", cronRunId);
      } catch (recordError) {
        console.error("[TRACER CRON RUN RECORD ERROR]", recordError);
      }
    }
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
