import "server-only";

import { collectGoogleTrendsDemand } from "@/lib/intelligence/collect-google-trends";
import { matchDemandProductsByCategory } from "@/lib/intelligence/match-demand-products";
import { normalizeProductIntelligence } from "@/lib/intelligence/normalize-products";
import { persistDemandCJProducts } from "@/lib/intelligence/persist-demand-cj-products";
import { researchDemandCandidateWithCJ } from "@/lib/intelligence/research-demand-cj";
import { scoreProductIntelligence } from "@/lib/intelligence/score-products";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isGeminiConfigured } from "@/lib/ai/gemini";

export type PipelineStepResult = {
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

async function runStep(
  name: string,
  fn: () => Promise<unknown>,
): Promise<PipelineStepResult> {
  try {
    const result = await fn();
    return { name, ok: true, result };
  } catch (error) {
    console.error(`[TRACER PIPELINE ${name}]`, error);
    return {
      name,
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
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
    return { skipped: true, reason: "gemini_not_configured", candidateId: candidate.id };
  }

  const researched = await researchDemandCandidateWithCJ(candidate.id);
  const persisted = await persistDemandCJProducts(candidate.id, 1);

  return { researched, persisted };
}

export async function runIntelligencePipeline(): Promise<{
  ok: boolean;
  steps: PipelineStepResult[];
}> {
  const steps: PipelineStepResult[] = [];

  steps.push(await runStep("discovery", () => collectGoogleTrendsDemand()));
  steps.push(await runStep("normalize", () => normalizeProductIntelligence()));
  steps.push(await runStep("match", () => matchDemandProductsByCategory()));
  steps.push(await runStep("supply", () => researchLimitedSupply()));
  steps.push(await runStep("intelligence", () => buildOpportunityIntelligence()));
  steps.push(await runStep("score", () => scoreProductIntelligence()));

  return {
    ok: steps.every((step) => step.ok),
    steps,
  };
}
