import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { linkInternalSupplyForBestseller } from "@/lib/suppliers/internal-catalog";
import { syncTracerCatalogFromInternalSupply } from "@/lib/suppliers/sync-tracer-catalog";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
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

    const { data: freshRows, error: freshError } = await supabase
      .from("marketplace_bestsellers")
      .select("id")
      .in("pipeline_status", ["pending", "failed"])
      .or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null")
      .order("fetched_at", { ascending: false })
      .limit(BESTSELLER_CANDIDATE_BATCH_SIZE);

    if (freshError) throw new Error(freshError.message);

    let candidateIds = (freshRows ?? []).map((row) => String(row.id));

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

      candidateIds = [...candidateIds, ...(retryRows ?? []).map((row) => String(row.id))]
        .filter((id, index, ids) => ids.indexOf(id) === index);
    }

    const internalMatchedIds: string[] = [];
    const internalResults: Record<string, unknown>[] = [];
    const externalCandidateIds: string[] = [];

    for (const candidateId of candidateIds) {
      const { data: bestseller, error } = await supabase
        .from("marketplace_bestsellers")
        .select("*")
        .eq("id", candidateId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!bestseller) {
        externalCandidateIds.push(candidateId);
        continue;
      }

      const internal = await linkInternalSupplyForBestseller({
        bestseller: bestseller as Record<string, unknown>,
        fetchedAt: String(bestseller.fetched_at ?? new Date().toISOString()),
      });

      if (!internal.matched) {
        externalCandidateIds.push(candidateId);
        continue;
      }

      internalMatchedIds.push(candidateId);
      const catalog = await syncTracerCatalogFromInternalSupply({
        bestsellerId: candidateId,
        salePrice: Number.isFinite(Number(bestseller.price)) ? Number(bestseller.price) : null,
      });
      internalResults.push({
        bestsellerId: candidateId,
        supplierListingId: internal.supplierListingId,
        catalog,
      });
    }

    const result = externalCandidateIds.length
      ? await investigateDropshipForBestsellers(externalCandidateIds)
      : {
          processed: 0,
          matched: 0,
          rowErrors: 0,
          skippedNoIdentifier: 0,
          unconfigured: 0,
          noIdentifierOverlap: 0,
          supplyBarcodeMissing: 0,
          rowErrorDetails: [],
        };

    const totalMatched = internalMatchedIds.length + result.matched;
    const metadata = {
      phase: "supplier_investigation",
      candidateCount: candidateIds.length,
      internalMatched: internalMatchedIds.length,
      externalCandidates: externalCandidateIds.length,
      externalMatched: result.matched,
      totalMatched,
      internalResults,
      skippedNoIdentifier: result.skippedNoIdentifier,
      unconfigured: result.unconfigured,
      noIdentifierOverlap: result.noIdentifierOverlap,
      supplyBarcodeMissing: result.supplyBarcodeMissing,
      rowErrors: result.rowErrors,
      // Sales-test publication, NEWFIND promotion, and BASE publication are
      // deliberately not chained here. Each has its own cron schedule.
    };

    if (cronRunId) {
      await supabase
        .from("cron_runs")
        .update({
          status: "succeeded",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          processed: candidateIds.length,
          failed: result.rowErrors,
          metadata,
        })
        .eq("id", cronRunId);
    }

    return NextResponse.json({
      ok: true,
      phase: "supplier_investigation",
      elapsedMs: Date.now() - startedAt,
      candidateIds,
      internalMatchedIds,
      internalResults,
      ...result,
      totalMatched,
      nextPhase: "sales_test_publication",
    });
  } catch (error) {
    if (cronRunId) {
      try {
        await supabase
          .from("cron_runs")
          .update({
            status: "failed",
            finished_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          })
          .eq("id", cronRunId);
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
