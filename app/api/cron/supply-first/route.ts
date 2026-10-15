import { NextResponse } from "next/server";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

const DISCOVERY_BUDGET_MS = 240_000;
// CJ live verification is already deadline-bounded; use the full 4-minute
// window to recover the remaining real supplier catalog instead of stopping
// after ten candidates.
const DISCOVERY_BATCH_SIZE = 40;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let db: ReturnType<typeof createSupabaseAdminClient> | null = null;
  let runId: string | null = null;

  try {
    db = createSupabaseAdminClient();
    const { data: run, error: startError } = await db.from("cron_runs").insert({
      job_name: "supply-first",
      status: "running",
      started_at: startedAtIso,
      processed: 0,
      failed: 0,
      metadata: { actor: "vercel-cron", batchSize: DISCOVERY_BATCH_SIZE, deadlineMs: DISCOVERY_BUDGET_MS },
    }).select("id").maybeSingle();
    if (startError) {
      console.error("[TRACER SUPPLY-FIRST RUN LOG START FAILED]", { stage: "cron_run_insert", code: startError.code ?? null });
    } else if (run?.id) {
      runId = String(run.id);
    }

    const supplyFirst = await discoverAndCreateCjSupply(DISCOVERY_BATCH_SIZE, {
      deadlineAt: startedAt + DISCOVERY_BUDGET_MS,
    });

    const verifiedProductIds = (supplyFirst.items ?? [])
      .map((item) => (item && typeof item === "object" && "productId" in item ? String((item as { productId?: unknown }).productId ?? "") : ""))
      .filter(Boolean);
    const opportunityIntelligence = verifiedProductIds.length > 0 && Date.now() - startedAt < 260_000
      ? await buildOpportunityIntelligence({ productIds: verifiedProductIds })
          .then((result) => ({ productIds: verifiedProductIds, processed: result.processed, testReady: result.testReady }))
          .catch((error) => ({ productIds: verifiedProductIds, error: error instanceof Error ? error.message : String(error) }))
      : { skipped: true, reason: verifiedProductIds.length > 0 ? "time_budget" : "no_verified_products" };

    const elapsedMs = Date.now() - startedAt;
    if (db && runId) {
      const { error: finishError } = await db.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: elapsedMs,
        processed: verifiedProductIds.length,
        failed: 0,
        metadata: {
          actor: "vercel-cron",
          batchSize: DISCOVERY_BATCH_SIZE,
          deadlineMs: DISCOVERY_BUDGET_MS,
          reason: typeof supplyFirst.reason === "string" ? supplyFirst.reason : null,
          retryable: supplyFirst.retryable === true,
          quotaBlocked: supplyFirst.quotaBlocked === true,
          deadlineReached: supplyFirst.deadlineReached === true,
          candidateCount: Number(supplyFirst.candidateCount ?? 0),
          discovered: Number(supplyFirst.discovered ?? 0),
          verified: Number(supplyFirst.verified ?? verifiedProductIds.length),
          published: Number(supplyFirst.published ?? 0),
          retryAfter: typeof supplyFirst.retryAfter === "string" ? supplyFirst.retryAfter : null,
          opportunityIntelligence: {
            skipped: typeof opportunityIntelligence === "object" && opportunityIntelligence !== null && "skipped" in opportunityIntelligence
              ? Boolean(opportunityIntelligence.skipped)
              : false,
            processed: typeof opportunityIntelligence === "object" && opportunityIntelligence !== null && "processed" in opportunityIntelligence
              ? Number(opportunityIntelligence.processed)
              : 0,
          },
        },
      }).eq("id", runId);
      if (finishError) console.error("[TRACER SUPPLY-FIRST RUN LOG FINISH FAILED]", { stage: "cron_run_update", code: finishError.code ?? null });
    }

    return NextResponse.json({
      ok: true,
      elapsedMs,
      supplyFirst,
      opportunityIntelligence,
      publication: {
        published: 0,
        base: false,
        newfind: false,
        reason: "deferred_to_opportunity_intelligence_and_sales_test_gate",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const stage = message.split(":")[0].slice(0, 100);
    if (db && runId) {
      const { error: finishError } = await db.from("cron_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: 0,
        failed: 1,
        error: stage,
        metadata: { actor: "vercel-cron", batchSize: DISCOVERY_BATCH_SIZE, deadlineMs: DISCOVERY_BUDGET_MS, errorStage: stage },
      }).eq("id", runId);
      if (finishError) console.error("[TRACER SUPPLY-FIRST RUN LOG FAILURE UPDATE FAILED]", { stage: "cron_run_update", code: finishError.code ?? null });
    }
    console.error("[TRACER SUPPLY-FIRST CRON ERROR]", { stage });
    return NextResponse.json(
      { ok: false, error: stage },
      { status: 500 },
    );
  }
}