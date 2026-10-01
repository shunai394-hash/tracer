import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";

export const runtime = "nodejs";
export const maxDuration = 300;

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

    // Discovery is not publication. Build Opportunity Intelligence first,
    // then let the strict supply sales-test gate decide whether anything can publish.
    const supplyFirst = await discoverAndCreateCjSupply(20, {
      deadlineAt: startedAt + 150_000,
    });
    await buildOpportunityIntelligence();
    const supplySelected = await selectAndPublishSupplySalesTests(
      supplyFirst.items.map((item) => String(item.productId ?? "")).filter(Boolean),
      3,
    );

    if (cronRunId) {
      await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: supplyFirst.candidateCount,
        failed: supplyFirst.rejected,
        metadata: {
          phase: "sales_test_publication",
          mode: "supply_first_intelligence_gate",
          candidateCount: supplyFirst.candidateCount,
          discovered: supplyFirst.discovered,
          verified: supplyFirst.verified,
          published: supplySelected.published,
          rejected: supplyFirst.rejected,
        },
      }).eq("id", cronRunId);
    }

    if (supplySelected.published > 0) {
      return NextResponse.json({
        ok: true,
        phase: "sales_test_publication",
        elapsedMs: Date.now() - startedAt,
        mode: "supply_first_intelligence_gate",
        supplyFirst,
        supplySelected,
        nextPhase: "base_publication",
      });
    }

    // Keep the existing market-linked pipeline as the fallback when the
    // supply-first source has no publishable candidate.
    const { data: readyRows, error: readyError } = await supabase
      .from("marketplace_bestsellers")
      .select("id")
      .eq("pipeline_stage", "VARIANT_VERIFIED")
      .eq("pipeline_status", "ready")
      .order("fetched_at", { ascending: false })
      .limit(10);

    if (readyError) throw new Error(readyError.message);

    const candidateIds = (readyRows ?? []).map((row) => String(row.id));
    const decision = await selectAndPublishSalesTests(candidateIds, 10);

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
        metadata: {
          phase: "sales_test_publication",
          mode: "market_linked_fallback",
          considered: decision.considered,
          published: decision.published,
          newfind: newfind.length,
        },
      }).eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: true,
      phase: "sales_test_publication",
      elapsedMs: Date.now() - startedAt,
      mode: "market_linked_fallback",
      candidateCount: candidateIds.length,
      decision,
      newfind,
      nextPhase: "base_publication",
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
