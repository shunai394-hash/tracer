import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
    const { data: cronRun, error: claimError } = await supabase
      .from("cron_runs")
      .insert({
        job_name: "supplier-investigation",
        status: "running",
        metadata: { phase: "supplier_investigation" },
      })
      .select("id")
      .single();

    if (claimError) {
      if (claimError.code === "23505") {
        return NextResponse.json(
          { ok: true, skipped: true, reason: "cron_already_running", job: "supplier-investigation" },
          { status: 409 },
        );
      }
      throw new Error(claimError.message);
    }

    cronRunId = cronRun?.id ? String(cronRun.id) : null;

    // Prefer rows with machine-verifiable numeric identifiers first.
    // MPN-only rows can be useful, but marketplace MPN values are frequently
    // free-form and caused the supplier stage to spend its whole runtime on
    // title discovery without producing a sales-eligible identity.
    const { data: freshRows, error: freshError } = await supabase
      .from("marketplace_bestsellers")
      .select("id")
      .in("pipeline_status", ["pending", "failed"])
      .or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null")
      .order("fetched_at", { ascending: false })
      .limit(BESTSELLER_CANDIDATE_BATCH_SIZE);

    if (freshError) throw new Error(freshError.message);

    let candidateIds = (freshRows ?? []).map((row) => String(row.id));

    // Only fall back to MPN/ASIN discovery when there is no barcode-grade
    // candidate available. This keeps the one-item batch focused on a
    // verifiable product and avoids burning the CJ rate-limit window on weak
    // candidates. The downstream identity gate remains unchanged.

    if (candidateIds.length < BESTSELLER_CANDIDATE_BATCH_SIZE) {
      const retrySlots = BESTSELLER_CANDIDATE_BATCH_SIZE - candidateIds.length;
      const retryBefore = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: retryRows, error: retryError } = await supabase
        .from("marketplace_bestsellers")
        .select("id")
        .eq("pipeline_status", "blocked")
        .lt("pipeline_updated_at", retryBefore)
        .or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null,mpn.not.is.null,asin.not.is.null")
        .order("pipeline_updated_at", { ascending: true })
        .limit(retrySlots);

      if (retryError) throw new Error(retryError.message);

      candidateIds = [
        ...candidateIds,
        ...(retryRows ?? []).map((row) => String(row.id)),
      ].filter((id, index, ids) => ids.indexOf(id) === index);
    }

    const result = await investigateDropshipForBestsellers(candidateIds);

    // Do not wait for a later cron window once a real supplier match is
    // verified. One successful candidate is immediately passed through the
    // sales-test gate and then BASE publication in the same invocation.
    // The existing dedicated sales-test/base crons remain as safe retries.
    let salesTest: Awaited<ReturnType<typeof selectAndPublishSalesTests>> | null = null;
    let basePublication: Awaited<ReturnType<typeof publishPublishedListingsToBase>> | null = null;

    if (result.matched > 0 && candidateIds.length > 0) {
      salesTest = await selectAndPublishSalesTests(candidateIds, 1);
      if (salesTest.publishedListingIds.length > 0) {
        basePublication = await publishPublishedListingsToBase(20);
      }
    }

    if (cronRunId) {
      await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: result.processed,
        failed: result.rowErrors,
        metadata: {
          phase: "supplier_investigation",
          candidateCount: candidateIds.length,
          matched: result.matched,
          skippedNoIdentifier: result.skippedNoIdentifier,
          unconfigured: result.unconfigured,
          noIdentifierOverlap: result.noIdentifierOverlap,
          supplyBarcodeMissing: result.supplyBarcodeMissing,
          chainedSalesTestPublished: salesTest?.published ?? 0,
          chainedBasePublished: basePublication?.published ?? 0,
        },
      }).eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: true,
      phase: "supplier_investigation",
      elapsedMs: Date.now() - startedAt,
      candidateIds,
      ...result,
      salesTest,
      basePublication,
      nextPhase: "sales_test_publication",
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

    console.error("[TRACER SUPPLIER INVESTIGATION CRON ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        phase: "supplier_investigation",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
