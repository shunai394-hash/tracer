import "server-only";

import { collectGoogleTrendsDemand } from "@/lib/intelligence/collect-google-trends";
import { matchDemandProductsByCategory } from "@/lib/intelligence/match-demand-products";
import { normalizeProductIntelligence } from "@/lib/intelligence/normalize-products";
import { persistDemandCJProducts } from "@/lib/intelligence/persist-demand-cj-products";
import { researchDemandCandidateWithCJ } from "@/lib/intelligence/research-demand-cj";
import { scoreProductIntelligence } from "@/lib/intelligence/score-products";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { persistDemandIntelligence } from "@/lib/intelligence/persist-demand-intelligence";
import { persistReorderRecommendations } from "@/lib/ordering/persist-reorder";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import {
  promoteShopListingToNewfind,
  retryPendingNewfindPromotions,
} from "@/lib/integration/newfind";
import { stampDemandCJIdentities } from "@/lib/intelligence/stamp-cj-identities";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readMarketCursor, writeMarketCursor } from "@/lib/market/market-cursor";
import { reverifyCjSupplyIdentities } from "@/lib/suppliers/reverify-cj-identity";
import { isGeminiConfigured } from "@/lib/ai/gemini";
import {
  GeminiConfigError,
  GeminiRequestError,
  GeminiTimeoutError,
} from "@/lib/ai/gemini/errors";

export type PipelineStepResult = {
  name: string;
  ok: boolean;
  skipped?: boolean;
  retryable?: boolean;
  result?: unknown;
  error?: string;
};

function classifyFailure(error: unknown): {
  retryable: boolean;
  skippable: boolean;
  message: string;
} {
  const message = error instanceof Error ? error.message : "Unknown error";
  const geminiFailure =
    error instanceof GeminiConfigError ||
    error instanceof GeminiRequestError ||
    error instanceof GeminiTimeoutError ||
    /gemini|429|quota|rate limit/i.test(message);

  return {
    retryable:
      geminiFailure ||
      /timeout|temporar|econnreset|503|502|fetch failed/i.test(message),
    skippable: geminiFailure,
    message,
  };
}

// Deadline handling. Vercel kills the function at maxDuration (300s) without
// running any cleanup, which leaves half-finished work and a running lock.
// Every step checks the remaining budget first; a step that cannot start in
// time is recorded as deferred (skipped, retryable) and the next patrol
// resumes from persisted cursors / due queues instead of repeating work.
let pipelineDeadlineAt = Number.POSITIVE_INFINITY;
let pipelineProgress: ((step: string) => Promise<void>) | null = null;

class StepTimeoutError extends Error {
  constructor(step: string, budgetMs: number) {
    super(`${step} exceeded its ${budgetMs}ms patrol budget`);
    this.name = "StepTimeoutError";
  }
}

// Reserve time for the cheap downstream stages (intelligence, Sales Test
// Gate, NEWFIND) so an expensive discovery stage cannot starve them.
const DOWNSTREAM_RESERVE_MS = 75_000;

async function runStep(
  name: string,
  fn: () => Promise<unknown>,
  options: { downstream?: boolean } = {},
): Promise<PipelineStepResult> {
  const remaining = pipelineDeadlineAt - Date.now();
  const required = options.downstream ? 5_000 : DOWNSTREAM_RESERVE_MS;
  if (remaining < required) {
    return {
      name,
      ok: true,
      skipped: true,
      retryable: true,
      result: { skipped: true, reason: "deferred_to_next_patrol_time_budget", remainingMs: Math.max(0, remaining) },
    };
  }
  // Hard per-step budget. Checking only before a step starts cannot stop a
  // single slow step (marketplace fetch, CJ fan-out) from running past 300s,
  // which is what kept killing patrol-ai and leaving its lock behind.
  const budgetMs = Math.max(1_000, options.downstream ? remaining - 2_000 : remaining - DOWNSTREAM_RESERVE_MS);
  const startedAt = Date.now();
  await pipelineProgress?.(name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(name, budgetMs)), budgetMs);
      }),
    ]);
    const skipped =
      result !== null &&
      typeof result === "object" &&
      "skipped" in result &&
      (result as { skipped?: boolean }).skipped === true;

    return { name, ok: true, skipped, result };
  } catch (error) {
    if (error instanceof StepTimeoutError) {
      console.warn(`[TRACER PIPELINE ${name}] deferred after ${Date.now() - startedAt}ms (budget ${budgetMs}ms)`);
      return {
        name,
        ok: true,
        skipped: true,
        retryable: true,
        result: { skipped: true, reason: "step_time_budget_exceeded_deferred", budgetMs, elapsedMs: Date.now() - startedAt },
      };
    }
    const classified = classifyFailure(error);
    console.error(`[TRACER PIPELINE ${name}]`, error);
    return {
      name,
      ok: classified.skippable,
      skipped: classified.skippable,
      retryable: classified.retryable,
      error: classified.message,
      result: classified.skippable
        ? { skipped: true, reason: "isolated_failure", retryable: classified.retryable }
        : undefined,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function researchLimitedSupply(): Promise<unknown> {
  const supabase = createSupabaseAdminClient();

  const { data: candidates, error } = await supabase
    .from("demand_product_candidates")
    .select("id, status")
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  const candidate = candidates?.[0];
  if (!candidate) return { skipped: true, reason: "no_new_candidates" };

  if (!isGeminiConfigured()) {
    return {
      skipped: true,
      reason: "gemini_not_configured",
      candidateId: candidate.id,
      note: "CJ research uses Gemini for query ideation only; intelligence scoring continues without it",
    };
  }

  try {
    const researched = await researchDemandCandidateWithCJ(candidate.id);
    const persisted = await persistDemandCJProducts(candidate.id, 3);
    return { researched, persisted };
  } catch (error) {
    const classified = classifyFailure(error);
    if (classified.skippable) {
      return {
        skipped: true,
        retryable: classified.retryable,
        reason: "gemini_failed",
        candidateId: candidate.id,
        error: classified.message,
      };
    }
    throw error;
  }
}

async function syncShoppingDemandObservations(): Promise<unknown> {
  const supabase = createSupabaseAdminClient();
  const { data: rows, error } = await supabase
    .from("observations")
    .select("id, source_id, product_id, observed_at, raw_data")
    .eq("source_type", "search")
    .order("observed_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);

  const grouped = new Map<string, {
    sourceId: string;
    productId: string | null;
    observedAt: string;
    count: number;
    query: string;
  }>();

  for (const row of rows ?? []) {
    const raw = row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
      ? row.raw_data as Record<string, unknown>
      : {};
    const query = typeof raw.query === "string" ? raw.query.normalize("NFKC").trim() : "";
    if (!query || /[�]/.test(query)) continue;
    const day = String(row.observed_at).slice(0, 10);
    const key = `${query}|${day}`;
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
      if (!current.productId && typeof row.product_id === "string") current.productId = row.product_id;
      continue;
    }
    grouped.set(key, {
      sourceId: String(row.source_id),
      productId: typeof row.product_id === "string" ? row.product_id : null,
      observedAt: String(row.observed_at),
      count: 1,
      query,
    });
  }

  const { data: existingDemand, error: existingDemandError } = await supabase
    .from("demand_observations")
    .select("metadata, observed_at")
    .eq("signal_type", "search_result_count")
    .gte("observed_at", new Date(Date.now() - 90 * 86_400_000).toISOString());
  if (existingDemandError) throw new Error(existingDemandError.message);

  const existingKeys = new Set(
    (existingDemand ?? []).map((row) => {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      return `${typeof metadata.query === "string" ? metadata.query : ""}|${String(row.observed_at).slice(0, 10)}`;
    }),
  );

  let upserted = 0;
  for (const item of grouped.values()) {
    const key = `${item.query}|${item.observedAt.slice(0, 10)}`;
    if (existingKeys.has(key)) continue;
    const { error: insertError } = await supabase
      .from("demand_observations")
      .insert({
        product_id: item.productId,
        source_id: item.sourceId,
        signal_type: "search_result_count",
        value: item.count,
        unit: "google_shopping_results_observed",
        observed_at: item.observedAt,
        metadata: {
          query: item.query,
          provider: "google_shopping",
          source: "observations",
          proxy: "count_of_observed_product_results",
        },
      });
    if (insertError && insertError.code !== "23505") throw new Error(insertError.message);
    if (!insertError) upserted += 1;
  }

  return { source: "google_shopping_observations", grouped: grouped.size, upserted };
}

async function inspectDemandObservations(): Promise<unknown> {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("demand_observations")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return { observations: count ?? 0, source: "demand_observations", note: "Demand rows are written by discovery; this step only verifies they remain queryable" };
}

export async function runIntelligencePipeline(options: {
  deadlineAt?: number;
  /** Called as each step starts so a killed run still shows where it stopped. */
  onStep?: (step: string) => Promise<void>;
} = {}): Promise<{
  ok: boolean;
  complete: boolean;
  steps: PipelineStepResult[];
}> {
  const steps: PipelineStepResult[] = [];
  pipelineDeadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  pipelineProgress = options.onStep ?? null;
  const db = createSupabaseAdminClient();

  // Resume market discovery from the persisted cursor instead of re-reading
  // marketplace 0 / item 0 on every patrol, and advance it afterwards.
  const bestsellerStep = await runStep("bestsellers", async () => {
    const cursor = await readMarketCursor(db);
    const observation = await persistMarketplaceBestsellers({
      sourceIndex: cursor.sourceIndex,
      startIndex: cursor.startIndex,
      batchSize: 10,
    });
    const next = await writeMarketCursor(db, observation, "patrol-ai");
    return { ...observation, cursor, nextCursor: next };
  });
  steps.push(bestsellerStep);

  const bestsellerIds =
    bestsellerStep.ok && bestsellerStep.result && typeof bestsellerStep.result === "object" && Array.isArray((bestsellerStep.result as { bestsellerIds?: unknown }).bestsellerIds)
      ? ((bestsellerStep.result as { bestsellerIds: string[] }).bestsellerIds)
      : [];

  const supplierCandidateIds =
    bestsellerStep.ok && bestsellerStep.result && typeof bestsellerStep.result === "object" && Array.isArray((bestsellerStep.result as { supplierCandidateIds?: unknown }).supplierCandidateIds)
      ? (bestsellerStep.result as { supplierCandidateIds: string[] }).supplierCandidateIds
      : [];

  // Identity backlog: bestsellers that carry a barcode but were inserted by an
  // earlier patrol were never investigated (only the current run's inserts
  // were). Drain a few per patrol, oldest observations first.
  steps.push(await runStep("dropship", async () => {
    const { data: backlog, error: backlogError } = await db
      .from("marketplace_bestsellers")
      .select("id")
      .eq("pipeline_status", "pending")
      .or("jan.not.is.null,gtin.not.is.null,ean.not.is.null,upc.not.is.null")
      .order("fetched_at", { ascending: true })
      .limit(3);
    if (backlogError) throw new Error(backlogError.message);
    const ids = Array.from(new Set([
      ...supplierCandidateIds,
      ...(backlog ?? []).map((row) => String(row.id)),
    ]));
    return investigateDropshipForBestsellers(ids);
  }));
  steps.push(await runStep("auxiliary_trends", () => collectGoogleTrendsDemand()));
  steps.push(await runStep("normalize", () => normalizeProductIntelligence()));
  steps.push(await runStep("identity", () => stampDemandCJIdentities()));
  steps.push(await runStep("shopping_demand_sync", () => syncShoppingDemandObservations()));
  steps.push(await runStep("match", () => matchDemandProductsByCategory()));
  steps.push(await runStep("demand", () => inspectDemandObservations()));
  steps.push(await runStep("demand_analyze", () => persistDemandIntelligence()));
  steps.push(await runStep("supply", () => researchLimitedSupply()));

  // Supply-first is discovery only. It creates canonical product/offer/intelligence
  // evidence; publication is deferred until the same Opportunity Intelligence
  // and strict sales-test gates have passed.
  // Keep each patrol bounded: live CJ stock/freight and identity checks are
  // network-bound, while Opportunity Intelligence and Sales Test are also
  // required in the same invocation. Larger backlogs are drained by later patrols.
  const supplyFirstStep = await runStep("supply_first", () =>
    discoverAndCreateCjSupply(3, {
      deadlineAt: Math.min(pipelineDeadlineAt - DOWNSTREAM_RESERVE_MS, Date.now() + 120_000),
    }));
  steps.push(supplyFirstStep);

  const supplyItems =
    supplyFirstStep.result && typeof supplyFirstStep.result === "object" && Array.isArray((supplyFirstStep.result as { items?: unknown }).items)
      ? ((supplyFirstStep.result as { items: Array<Record<string, unknown>> }).items)
      : [];

  // Identity re-verification of existing CJ supply against marketplace
  // barcodes observed since. Unique exact barcode matches only.
  steps.push(await runStep("identity_reverify", () =>
    reverifyCjSupplyIdentities({
      limit: 5,
      deadlineAt: pipelineDeadlineAt - DOWNSTREAM_RESERVE_MS,
    })));

  const intelligence = await runStep("intelligence", () => buildOpportunityIntelligence(), { downstream: true });
  steps.push(intelligence);
  steps.push(await runStep("score", () => scoreProductIntelligence(), { downstream: true }));

  // Reconsider supply verified by earlier patrols too, so a deferred or
  // timed-out patrol does not strand verified supply before the gate.
  const supplyProductIds = supplyItems.map((item) => String(item.productId ?? "")).filter(Boolean);
  const { data: verifiedSupply } = await db
    .from("supplier_listings")
    .select("product_id")
    .eq("supplier", "cj")
    .eq("verification_status", "verified")
    .eq("orderable", true)
    .not("product_id", "is", null)
    .order("last_verified_at", { ascending: false, nullsFirst: false })
    .limit(50);
  const supplyCandidateIds = Array.from(new Set([
    ...supplyProductIds,
    ...(verifiedSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
  ]));
  const supplySalesStep = await runStep(
    "supply_sales_test_select",
    () => selectAndPublishSupplySalesTests(supplyCandidateIds, 3),
    { downstream: true },
  );
  steps.push(supplySalesStep);

  const salesTestStep = await runStep("sales_test_select", () => selectAndPublishSalesTests(bestsellerIds, 3), { downstream: true });
  steps.push(salesTestStep);

  // Both Sales Test Gate paths deliver to NEWFIND (previously only the
  // market path did). promoteShopListingToNewfind re-checks the gate.
  steps.push(await runStep("newfind_promotion", async () => {
    const ids = [salesTestStep, supplySalesStep].flatMap((step) => {
      const result = step.result as { publishedListingIds?: unknown } | undefined;
      return Array.isArray(result?.publishedListingIds)
        ? result.publishedListingIds.filter((id): id is string => typeof id === "string")
        : [];
    });
    return Promise.all(ids.map((id) => promoteShopListingToNewfind(id)));
  }, { downstream: true }));
  // NEWFIND has its own scheduled retry worker. Keep patrol delivery bounded so
  // one slow downstream destination cannot consume the entire patrol timeout.
  steps.push(await runStep("newfind_retry", () => retryPendingNewfindPromotions(1), { downstream: true }));

  steps.push(await runStep("ordering", () => persistReorderRecommendations()));
  steps.push(await runStep("test_ready", async () => {
    if (!intelligence.ok) {
      return { skipped: true, reason: "intelligence_step_failed", retryable: intelligence.retryable === true };
    }
    const result = intelligence.result as { testReady?: number } | undefined;
    return { testReady: result?.testReady ?? 0, note: "TEST_READY is produced only after the data quality gate" };
  }));

  const blockingFailed = steps.some((step) => !step.ok && !step.skipped);
  return { ok: !blockingFailed, complete: steps.every((step) => step.ok), steps };
}
