import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
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

    // Publication must be bounded around the candidates that can actually
    // reach the Sales Test Gate. A 1000-row intelligence sweep is wasteful and
    // can consume the 300s function budget before the publication decision.
    const { data: verifiedSupply, error: verifiedSupplyError } = await supabase
      .from("supplier_listings")
      .select("product_id")
      .eq("supplier", "cj")
      .eq("verification_status", "verified")
      .eq("orderable", true)
      .not("product_id", "is", null)
      .order("last_verified_at", { ascending: false, nullsFirst: false })
      .limit(50);
    if (verifiedSupplyError) throw new Error(verifiedSupplyError.message);

    const verifiedSupplyIds = Array.from(
      new Set((verifiedSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean)),
    );
    if (verifiedSupplyIds.length > 0) {
      await buildOpportunityIntelligence({ productIds: verifiedSupplyIds });
    }

    const supplySelected = await selectAndPublishSupplySalesTests(verifiedSupplyIds, 10);
    const supplyDownstream = await promoteGatePassedListings(supplySelected.publishedListingIds);

    if (supplySelected.published > 0) {
      if (cronRunId) {
        await supabase.from("cron_runs").update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          processed: supplySelected.considered,
          failed: 0,
          metadata: {
            phase: "sales_test_publication",
            mode: "supply_first_intelligence_gate",
            considered: supplySelected.considered,
            published: supplySelected.published,
          },
        }).eq("id", cronRunId);
      }

      return NextResponse.json({
        ok: true,
        phase: "sales_test_publication",
        elapsedMs: Date.now() - startedAt,
        mode: "supply_first_intelligence_gate",
        supplySelected,
        downstream: supplyDownstream,
        nextPhase: "base_publication",
      });
    }

    // Keep the existing market-linked pipeline as the fallback when the
    // supply-first source has no publishable candidate. Build OI specifically
    // for those ready rows before evaluating the shared Sales Test Gate.
    const { data: readyRows, error: readyError } = await supabase
      .from("marketplace_bestsellers")
      .select("id,product_id")
      .eq("pipeline_stage", "VARIANT_VERIFIED")
      .eq("pipeline_status", "ready")
      .not("product_id", "is", null)
      .order("fetched_at", { ascending: false })
      .limit(10);

    if (readyError) throw new Error(readyError.message);

    const candidateIds = (readyRows ?? []).map((row) => String(row.id));
    const marketProductIds = Array.from(
      new Set((readyRows ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean)),
    );
    if (marketProductIds.length > 0) {
      await buildOpportunityIntelligence({ productIds: marketProductIds });
    }

    const decision = await selectAndPublishSalesTests(candidateIds, 10);
    const downstream = await promoteGatePassedListings(decision.publishedListingIds);

    if (cronRunId) {
      await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: supplySelected.considered + candidateIds.length,
        failed: 0,
        metadata: {
          phase: "sales_test_publication",
          mode: "market_linked_sales_test",
          supplyConsidered: supplySelected.considered,
          supplyPublished: supplySelected.published,
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
