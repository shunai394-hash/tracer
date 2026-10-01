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
import { MARKETPLACE_SOURCES } from "@/lib/market/collect-bestsellers";
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

async function runStep(
  name: string,
  fn: () => Promise<unknown>,
): Promise<PipelineStepResult> {
  try {
    const result = await fn();
    const skipped =
      result !== null &&
      typeof result === "object" &&
      "skipped" in result &&
      (result as { skipped?: boolean }).skipped === true;

    return { name, ok: true, skipped, result };
  } catch (error) {
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

  if (error) {
    throw new Error(error.message);
  }

  const candidate = candidates?.[0];

  if (!candidate) {
    return { skipped: true, reason: "no_new_candidates" };
  }

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
    // Persist only after demand-relevance ranking. Never take CJ fetch order.
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
    if (insertError && insertError.code !== "23505") {
      throw new Error(insertError.message);
    }
    if (!insertError) upserted += 1;
  }

  return {
    source: "google_shopping_observations",
    grouped: grouped.size,
    upserted,
  };
}

async function getNextMarketplaceSourceIndex(): Promise<number> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from("cron_runs")
    .select("metadata")
    .eq("job_name", "market-sourcing")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const previous = data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? Number((data.metadata as Record<string, unknown>).sourceIndex)
    : NaN;

  if (Number.isInteger(previous) && previous >= 0) {
    return (previous + 1) % MARKETPLACE_SOURCES.length;
  }
  return 0;
}

async function inspectDemandObservations(): Promise<unknown> {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("demand_observations")
    .select("id", { count: "exact", head: true });

  if (error) {
    throw new Error(error.message);
  }

  return {
    observations: count ?? 0,
    source: "demand_observations",
    note: "Demand rows are written by discovery; this step only verifies they remain queryable",
  };
}

export async function runIntelligencePipeline(): Promise<{
  ok: boolean;
  complete: boolean;
  steps: PipelineStepResult[];
}> {
  const steps: PipelineStepResult[] = [];

  const bestsellerStep = await runStep("bestsellers", () => persistMarketplaceBestsellers());
  steps.push(bestsellerStep);

  const bestsellerIds =
    bestsellerStep.ok &&
    bestsellerStep.result &&
    typeof bestsellerStep.result === "object" &&
    Array.isArray((bestsellerStep.result as { bestsellerIds?: unknown }).bestsellerIds)
      ? ((bestsellerStep.result as { bestsellerIds: string[] }).bestsellerIds)
      : [];

  const supplierCandidateIds =
    bestsellerStep.ok &&
    bestsellerStep.result &&
    typeof bestsellerStep.result === "object" &&
    Array.isArray((bestsellerStep.result as { supplierCandidateIds?: unknown }).supplierCandidateIds)
      ? (bestsellerStep.result as { supplierCandidateIds: string[] }).supplierCandidateIds
      : [];

  steps.push(
    await runStep("dropship", () => investigateDropshipForBestsellers(supplierCandidateIds)),
  );
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
  const supplyFirstStep = await runStep(
    "supply_first",
    () => discoverAndCreateCjSupply(50),
  );
  steps.push(supplyFirstStep);

  const supplyItems =
    supplyFirstStep.result &&
    typeof supplyFirstStep.result === "object" &&
    Array.isArray((supplyFirstStep.result as { items?: unknown }).items)
      ? ((supplyFirstStep.result as { items: Array<Record<string, unknown>> }).items)
      : [];

  const intelligence = await runStep("intelligence", () =>
    buildOpportunityIntelligence(),
  );
  steps.push(intelligence);
  steps.push(await runStep("score", () => scoreProductIntelligence()));
  const supplyProductIds = supplyItems
    .map((item) => String(item.productId ?? ""))
    .filter(Boolean);
  steps.push(
    await runStep("supply_sales_test_select", () =>
      selectAndPublishSupplySalesTests(supplyProductIds, 3),
    ),
  );

  const salesTestStep = await runStep(
    "sales_test_select",
    () => selectAndPublishSalesTests(bestsellerIds, 3),
  );
  steps.push(salesTestStep);
  steps.push(
    await runStep("newfind_retry", () => retryPendingNewfindPromotions(20)),
  );
  steps.push(
    await runStep("newfind_promotion", async () => {
      const result = salesTestStep.result as
        | { publishedListingIds?: unknown }
        | undefined;
      const ids = Array.isArray(result?.publishedListingIds)
        ? result.publishedListingIds.filter((id): id is string => typeof id === "string")
        : [];
      return Promise.all(ids.map((id) => promoteShopListingToNewfind(id)));
    }),
  );

  steps.push(await runStep("ordering", () => persistReorderRecommendations()));
  steps.push(
    await runStep("test_ready", async () => {
      if (!intelligence.ok) {
        return {
          skipped: true,
          reason: "intelligence_step_failed",
          retryable: intelligence.retryable === true,
        };
      }

      const result = intelligence.result as { testReady?: number } | undefined;
      return {
        testReady: result?.testReady ?? 0,
        note: "TEST_READY is produced only after the data quality gate",
      };
    }),
  );

  const blockingFailed = steps.some((step) => !step.ok && !step.skipped);

  return {
    ok: !blockingFailed,
    complete: steps.every((step) => step.ok),
    steps,
  };
}


