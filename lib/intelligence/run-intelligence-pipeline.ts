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
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { stampDemandCJIdentities } from "@/lib/intelligence/stamp-cj-identities";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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

  steps.push(
    await runStep("dropship", () => investigateDropshipForBestsellers(bestsellerIds)),
  );
  const salesTestStep = await runStep(
    "sales_test_select",
    () => selectAndPublishSalesTests(bestsellerIds, 3),
  );
  steps.push(salesTestStep);
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
  steps.push(await runStep("auxiliary_trends", () => collectGoogleTrendsDemand()));
  steps.push(await runStep("normalize", () => normalizeProductIntelligence()));
  steps.push(await runStep("identity", () => stampDemandCJIdentities()));
  steps.push(await runStep("match", () => matchDemandProductsByCategory()));
  steps.push(await runStep("demand", () => inspectDemandObservations()));
  steps.push(await runStep("demand_analyze", () => persistDemandIntelligence()));
  steps.push(await runStep("supply", () => researchLimitedSupply()));

  const intelligence = await runStep("intelligence", () =>
    buildOpportunityIntelligence(),
  );
  steps.push(intelligence);
  steps.push(await runStep("score", () => scoreProductIntelligence()));
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


