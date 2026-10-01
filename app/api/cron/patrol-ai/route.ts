import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { runIntelligencePipeline } from "@/lib/intelligence/run-intelligence-pipeline";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";
import { rescueUndeliveredGatePassedListings } from "@/lib/integration/newfind";

export const runtime = "nodejs";
export const maxDuration = 300;

type Snapshot = {
  products: number;
  supplierListings: number;
  orderableSuppliers: number;
  shopListings: number;
  publishedListings: number;
  eligibleForBase: number;
  autoProcurementEligibleListings: number;
  onBase: number;
  basePublished: number;
  orders: number;
};

async function snapshot(db: ReturnType<typeof createSupabaseAdminClient>): Promise<Snapshot> {
  const productsQuery = db.from("products").select("*", { count: "exact", head: true });
  const supplierListingsQuery = db.from("supplier_listings").select("*", { count: "exact", head: true });
  const orderableSuppliersQuery = db.from("supplier_listings").select("*", { count: "exact", head: true }).eq("orderable", true);
  const shopListingsQuery = db.from("shop_listings").select("*", { count: "exact", head: true });
  const publishedListingsQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).eq("published", true);
  const eligibilityListingsQuery = db.from("shop_listings").select("supplier_name,orderable,inventory,image_url").eq("published", true);
  const onBaseQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).not("base_item_id", "is", null);
  const basePublishedQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).not("base_item_id", "is", null).eq("base_publication_status", "published").eq("published", true);
  const ordersQuery = db.from("shop_orders").select("*", { count: "exact", head: true });

  const [productsResult, supplierListingsResult, orderableSuppliersResult, shopListingsResult, publishedListingsResult, eligibilityListingsResult, onBaseResult, basePublishedResult, ordersResult] =
    await Promise.all([productsQuery, supplierListingsQuery, orderableSuppliersQuery, shopListingsQuery, publishedListingsQuery, eligibilityListingsQuery, onBaseQuery, basePublishedQuery, ordersQuery]);

  const results = [
    ["products", productsResult], ["supplier_listings", supplierListingsResult], ["supplier_listings(orderable)", orderableSuppliersResult],
    ["shop_listings", shopListingsResult], ["shop_listings(published)", publishedListingsResult], ["shop_listings(eligibility)", eligibilityListingsResult],
    ["shop_listings(on_base)", onBaseResult], ["shop_listings(base_published)", basePublishedResult], ["shop_orders", ordersResult],
  ] as const;

  for (const [label, result] of results) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  const eligibleRows = (eligibilityListingsResult.data ?? []).filter((row) => {
    const inventory = Number(row.inventory);
    return row.orderable === true &&
      Number.isFinite(inventory) &&
      inventory > 0 &&
      row.image_url !== null &&
      row.image_url !== "" &&
      getAutoProcurementEligibility(typeof row.supplier_name === "string" ? row.supplier_name : null).eligible;
  });

  const autoProcurementEligibleRows = (eligibilityListingsResult.data ?? []).filter((row) =>
    getAutoProcurementEligibility(typeof row.supplier_name === "string" ? row.supplier_name : null).eligible
  );

  return {
    products: productsResult.count ?? 0,
    supplierListings: supplierListingsResult.count ?? 0,
    orderableSuppliers: orderableSuppliersResult.count ?? 0,
    shopListings: shopListingsResult.count ?? 0,
    publishedListings: publishedListingsResult.count ?? 0,
    eligibleForBase: eligibleRows.length,
    autoProcurementEligibleListings: autoProcurementEligibleRows.length,
    onBase: onBaseResult.count ?? 0,
    basePublished: basePublishedResult.count ?? 0,
    orders: ordersResult.count ?? 0,
  };
}

async function runPatrol(db: ReturnType<typeof createSupabaseAdminClient>) {
  const existing = await db
    .from("cron_runs")
    .select("id,started_at")
    .eq("job_name", "patrol-ai")
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing.error) throw new Error(`patrol running check failed: ${existing.error.message}`);
  if (existing.data?.id) {
    return { alreadyRunning: true, cronId: String(existing.data.id), startedAt: existing.data.started_at };
  }

  const { data: run, error: runError } = await db.from("cron_runs").insert({
    job_name: "patrol-ai",
    status: "running",
    metadata: { actor: "patrol-ai", phase: "starting" },
  }).select("id").single();

  if (runError) {
    if (runError.code === "23505") {
      return { alreadyRunning: true, cronId: null, startedAt: null };
    }
    throw new Error(`patrol run creation failed: ${runError.message}`);
  }

  return { alreadyRunning: false, cronId: String(run.id), startedAt: null };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  let cronId: string | null = null;

  try {
    // A Vercel timeout can leave the singleton lock in `running` forever.
    // Reclaim only rows older than this route's maxDuration before acquiring it.
    await recoverStaleCronRun(db, "patrol-ai", 300);
    const runState = await runPatrol(db);
    if (runState.alreadyRunning) {
      return NextResponse.json({
        ok: true,
        status: "already_running",
        message: "別のAI巡回が実行中のため、この重複起動は処理せず終了しました。",
        cronId: runState.cronId,
      });
    }
    cronId = runState.cronId;

    const before = await snapshot(db);
    console.log("[TRACER PATROL AI START]", JSON.stringify({ before }));

    // The patrol must always execute the canonical full intelligence loop.
    // AI patrol must not choose a shallow repair path that bypasses Market,
    // Identity, Demand, Supply, Opportunity, and the Sales Test Gate.
    // Leave room for BASE publication, NEWFIND rescue and the cron_runs
    // bookkeeping below; deferred stages resume on the next patrol.
    const pipeline = await runIntelligencePipeline({ deadlineAt: startedAt + 200_000 });

    const actions: Array<Record<string, unknown>> = [{
      action: "run_full_intelligence_pipeline",
      result: pipeline,
    }];
    const errors = pipeline.ok ? [] : pipeline.steps
      .filter((step) => !step.ok && !step.skipped)
      .map((step) => `${step.name}: ${step.error ?? "failed"}`);

    try {
      const base = await publishPublishedListingsToBase(10);
      actions.push({
        action: "publish_base",
        attempted: base.attempted,
        published: base.published,
        skipped: base.skipped,
        failed: base.failed,
        results: base.results,
      });
      for (const item of base.results) {
        if (!item.ok && !item.skipped && item.error) errors.push(String(item.error));
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      actions.push({ action: "publish_base", ok: false, error: errors.at(-1) });
    }

    // BASE -> NEWFIND: deliver gate-passed listings that never reached NEWFIND
    // (no delivery row, pending, failed or unacknowledged). Idempotent.
    try {
      const rescue = await rescueUndeliveredGatePassedListings({
        limit: 3,
        deadlineAt: startedAt + 270_000,
      });
      actions.push({ action: "newfind_rescue", result: rescue });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      actions.push({ action: "newfind_rescue", ok: false, error: errors.at(-1) });
    }

    const after = await snapshot(db);
    const progress = {
      newPublishedListings: after.publishedListings - before.publishedListings,
      newBasePublished: after.basePublished - before.basePublished,
      newOrders: after.orders - before.orders,
      testReady: pipeline.steps.find((step) => step.name === "test_ready")?.result ?? null,
    };

    const status = errors.length === 0 ? "succeeded" : "failed";
    const report = {
      ok: errors.length === 0,
      status,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      decision: "full_intelligence_cycle",
      before,
      after,
      progress,
      actions,
      errors,
      message: errors.length
        ? "AI巡回でフルIntelligence Pipelineを実行しましたが、未解決エラーがあります。"
        : progress.newPublishedListings > 0
          ? "AI巡回でフルIntelligence Pipelineを実行し、新規公開まで進みました。"
          : "AI巡回でフルIntelligence Pipelineを実行しました。今回は新規公開条件を満たす商品はありませんでした。",
    };

    console.log("[TRACER PATROL AI REPORT]", JSON.stringify(report));

    if (cronId) {
      await db.from("cron_runs").update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: after.publishedListings,
        failed: errors.length,
        status,
        error: errors.length ? errors.join("; ") : null,
        metadata: report,
      }).eq("id", cronId);
    }

    return NextResponse.json(report, { status: errors.length ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[TRACER PATROL AI FATAL]", message);
    if (cronId) {
      await db.from("cron_runs").update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        status: "failed",
        error: message,
        metadata: { actor: "patrol-ai", fatal: true },
      }).eq("id", cronId);
    }
    return NextResponse.json({ ok: false, status: "failed", error: message }, { status: 500 });
  }
}
