import "server-only";

import { collectGoogleTrendsDemand } from "@/lib/intelligence/collect-google-trends";
import { normalizeProductIntelligence } from "@/lib/intelligence/normalize-products";
import { scoreProductIntelligence } from "@/lib/intelligence/score-products";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { persistDemandIntelligence } from "@/lib/intelligence/persist-demand-intelligence";
import { persistReorderRecommendations } from "@/lib/ordering/persist-reorder";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { stampDemandCJIdentities } from "@/lib/intelligence/stamp-cj-identities";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
  category: "gemini" | "supplier_quota" | "transient" | "fatal";
} {
  const message = error instanceof Error ? error.message : "Unknown error";
  const errorCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  // CJ quota errors can occur during supplier search after query ideation.
  // Never mislabel generic "quota"/HTTP 429 text as a Gemini failure.
  const supplierQuotaFailure =
    errorCode === "CJ_QUOTA_EXHAUSTED" ||
    errorCode === "CJ_QUOTA_CIRCUIT_STATE_UNKNOWN" ||
    /CJ API quota cooldown|CJ quota circuit state/i.test(message);
  const geminiFailure =
    error instanceof GeminiConfigError ||
    error instanceof GeminiRequestError ||
    error instanceof GeminiTimeoutError ||
    /gemini/i.test(message);
  const transientFailure =
    /timeout|temporar|econnreset|503|502|fetch failed|429|quota|rate limit/i.test(message);

  return {
    retryable: supplierQuotaFailure || geminiFailure || transientFailure,
    skippable: supplierQuotaFailure || geminiFailure,
    message,
    category: supplierQuotaFailure
      ? "supplier_quota"
      : geminiFailure
        ? "gemini"
        : transientFailure
          ? "transient"
          : "fatal",
  };
}

// Deadline handling. Vercel kills the function at maxDuration (300s) without
// running any cleanup, which leaves half-finished work and a running lock.
// Every step checks the remaining budget first; a step that cannot start in
// time is recorded as deferred (skipped, retryable) and the next patrol
// resumes from persisted cursors / due queues instead of repeating work.
let pipelineDeadlineAt = Number.POSITIVE_INFINITY;
let pipelineProgress: ((step: string) => Promise<void>) | null = null;
// A timed-out step may still be finishing an in-flight network call because
// Promise.race does not cancel the underlying promise. Once that happens,
// never start another pipeline stage in the same invocation.
let pipelineTimedOut = false;

class StepTimeoutError extends Error {
  constructor(step: string, budgetMs: number) {
    super(`${step} exceeded its ${budgetMs}ms patrol budget`);
    this.name = "StepTimeoutError";
  }
}

// Explicit per-stage budgets keep expensive discovery stages from starving
// Opportunity Intelligence and the Sales Test Gate. The old downstream
// default was only 4s, which made intelligence defer almost every time.
const MIN_STEP_REMAINING_MS = 1_000;

async function runStep(
  name: string,
  fn: () => Promise<unknown>,
  options: { downstream?: boolean; budgetMs?: number; stopPipelineOnTimeout?: boolean } = {},
): Promise<PipelineStepResult> {
  const remaining = pipelineDeadlineAt - Date.now();
  const requestedBudget = options.budgetMs ?? (options.downstream ? 10_000 : Math.max(1_000, remaining - MIN_STEP_REMAINING_MS));
  const budgetMs = Math.min(
    Math.max(MIN_STEP_REMAINING_MS, requestedBudget),
    Math.max(MIN_STEP_REMAINING_MS, remaining - MIN_STEP_REMAINING_MS),
  );
  if (pipelineTimedOut) {
    return {
      name,
      ok: true,
      skipped: true,
      retryable: true,
      result: { skipped: true, reason: "previous_step_timeout_stops_pipeline" },
    };
  }
  if (remaining < MIN_STEP_REMAINING_MS || budgetMs < MIN_STEP_REMAINING_MS) {
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
  // Explicit budgets below protect the expensive stages; downstream defaults
  // remain short for cheap delivery/bookkeeping work.
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

    const retryable =
      result !== null &&
      typeof result === "object" &&
      "retryable" in result &&
      (result as { retryable?: boolean }).retryable === true;

    return { name, ok: true, skipped, retryable, result };
  } catch (error) {
    if (error instanceof StepTimeoutError) {
      if (options.stopPipelineOnTimeout !== false) pipelineTimedOut = true;
      console.warn(`[TRACER PIPELINE ${name}] deferred after ${Date.now() - startedAt}ms (budget ${budgetMs}ms); ${options.stopPipelineOnTimeout === false ? "continuing independent stages" : "stopping downstream stages"}`);
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

    const metadata = {
      query: item.query,
      provider: "google_shopping",
      source: "observations",
      proxy: "count_of_observed_product_results",
    };
    const payload = {
      product_id: item.productId,
      source_id: item.sourceId,
      signal_type: "search_result_count" as const,
      value: item.count,
      unit: "google_shopping_results_observed",
      observed_at: item.observedAt,
      metadata,
    };

    const { error: insertError } = await supabase
      .from("demand_observations")
      .insert(payload);
    if (!insertError) {
      upserted += 1;
      continue;
    }
    if (insertError.code === "23505") continue;

    // Production supports search_result_count. Never downgrade this
    // semantic signal to "other": a schema mismatch is a deployment/data
    // contract failure and must remain visible.
    throw new Error(insertError.message);
  }

  return {
    source: "google_shopping_observations",
    grouped: grouped.size,
    upserted,
  };
}

async function inspectDemandObservations(): Promise<unknown> {
  const supabase = createSupabaseAdminClient();
  const { count, error } = await supabase
    .from("demand_observations")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return { observations: count ?? 0, source: "demand_observations", note: "Demand rows are written by discovery; this step only verifies they remain queryable" };
}

/**
 * Product ids of published shop listings that have no opportunity
 * intelligence, or intelligence older than 24h. Oldest first, bounded.
 */
async function listedProductsNeedingIntelligence(
  db: ReturnType<typeof createSupabaseAdminClient>,
  limit: number,
): Promise<string[]> {
  const { data: listed, error } = await db
    .from("shop_listings")
    .select("product_id")
    .eq("published", true)
    .not("product_id", "is", null)
    .limit(500);
  if (error) throw new Error(error.message);
  const ids = Array.from(new Set((listed ?? []).map((row) => String(row.product_id))));
  if (ids.length === 0) return [];
  const fresh = new Set<string>();
  const staleBefore = new Date(Date.now() - 24 * 3_600_000).toISOString();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error: oiError } = await db
      .from("opportunity_intelligence")
      .select("product_id, updated_at")
      .in("product_id", ids.slice(i, i + 100))
      .gte("updated_at", staleBefore);
    if (oiError) throw new Error(oiError.message);
    for (const row of data ?? []) fresh.add(String(row.product_id));
  }
  return ids.filter((id) => !fresh.has(id)).slice(0, limit);
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
  pipelineTimedOut = false;
  const db = createSupabaseAdminClient();

  // Live CJ catalog discovery runs in /api/cron/supply-first on its own
  // four-times-daily 4-minute budget. Calling it again from every five-minute
  // patrol repeatedly hit the 18-second sub-budget, produced deadlineReached
  // with no candidates, and competed with the same supplier API quota.
  // Keep the stage explicit for pipeline observability; this patrol consumes
  // already-persisted verified supplier rows below.
  const supplyFirstStep: PipelineStepResult = {
    name: "supply_first",
    ok: true,
    skipped: true,
    retryable: false,
    result: {
      skipped: true,
      reason: "dedicated_supply_first_cron_owns_live_cj_discovery",
      discoveryCron: "/api/cron/supply-first",
    },
  };
  steps.push(supplyFirstStep);

  const supplyItems =
    supplyFirstStep.result && typeof supplyFirstStep.result === "object" && Array.isArray((supplyFirstStep.result as { items?: unknown }).items)
      ? ((supplyFirstStep.result as { items: Array<Record<string, unknown>> }).items)
      : [];


  // Demand matching runs in its own five-minute cron. Keep broad catalog reads
  // out of this pipeline so slow data reads cannot starve product publication.

  // TRACER sources products from supplier-native records only.
  // Marketplace-derived rankings are intentionally disabled: they are not supplier
  // identity, stock, cost, shipping, or orderability evidence and must not block
  // or feed sales publication.
  const bestsellerStep: PipelineStepResult = {
    name: "bestsellers",
    ok: true,
    skipped: true,
    retryable: false,
    result: { skipped: true, reason: "marketplace_sourcing_disabled_supplier_native_only" },
  };
  steps.push(bestsellerStep);
  const bestsellerCanFeedSalesGate = false;
  const bestsellerIds: string[] = [];

  steps.push(await runStep("auxiliary_trends", () => collectGoogleTrendsDemand(), { budgetMs: 5_000 }));

  // CJ identity re-verification runs through its dedicated cron endpoint only.
  // Keeping it out of this pipeline prevents timed-out network requests from
  // overlapping bestseller collection and violating CJ's 1-request/second quota.

  const normalizeWindowSize = 200;
  const normalizeProductCount = await db
    .from("products")
    .select("id", { count: "exact", head: true });
  if (normalizeProductCount.error) throw new Error(`Failed to count products for normalization: ${normalizeProductCount.error.message}`);
  const normalizePages = Math.max(1, Math.ceil((normalizeProductCount.count ?? 0) / normalizeWindowSize));
  const normalizeOffset = (Math.floor(Date.now() / 60_000) % normalizePages) * normalizeWindowSize;
  steps.push(await runStep("normalize", () => normalizeProductIntelligence({ limit: normalizeWindowSize, offset: normalizeOffset }), { budgetMs: 10_000 }));
  steps.push(await runStep("identity", () => stampDemandCJIdentities(), {
    budgetMs: 20_000,
    stopPipelineOnTimeout: false,
  }));
  steps.push(await runStep("shopping_demand_sync", () => syncShoppingDemandObservations(), { budgetMs: 15_000 }));
  steps.push(await runStep("demand", () => inspectDemandObservations(), { budgetMs: 5_000 }));
  steps.push(await runStep("demand_analyze", () => persistDemandIntelligence(), { budgetMs: 25_000 }));
  // Do not run the legacy one-candidate CJ research call in the critical patrol.
  // It repeatedly consumes its 18s budget and stops downstream publication. The
  // bounded supply-first catalog route handles fresh CJ discovery independently.




  // Supply-first is the primary product-discovery path. Run it before marketplace
  // scraping and broad intelligence so a short patrol deadline cannot starve CJ discovery.
  // Rotate over every product_intelligence page. The previous fixed
  // "% 7" rotation only ever reached the first 350 rows (ordered by
  // product_id), so most products never got opportunity_intelligence.
  const intelligenceBatchSize = 50;
  const { count: intelligenceRowCount } = await db
    .from("product_intelligence")
    .select("product_id", { count: "exact", head: true });
  const intelligencePages = Math.max(1, Math.ceil((intelligenceRowCount ?? 0) / intelligenceBatchSize));
  const intelligenceBatchOffset = (Math.floor(Date.now() / 60_000) % intelligencePages) * intelligenceBatchSize;
  // Products already listed in the shop (e.g. CATALOG_TEST listings) must be
  // evaluated by the same Opportunity Intelligence before the Sales Test Gate
  // can judge them. The page-by-page sweep can take many patrols to reach a
  // given product, so listed products without (fresh) intelligence go first.
  // This only computes intelligence; publication still requires the gate.
  const listedProductIds = await listedProductsNeedingIntelligence(db, 20);
  steps.push(await runStep(
    "intelligence_listed",
    async () => listedProductIds.length > 0
      ? { productIds: listedProductIds, ...(await buildOpportunityIntelligence({ productIds: listedProductIds })) }
      : { skipped: true, reason: "no_listed_product_without_intelligence" },
    { downstream: true, budgetMs: 30_000 },
  ));

  const intelligence = await runStep(
    "intelligence",
    () => buildOpportunityIntelligence({
      batchSize: intelligenceBatchSize,
      batchOffset: intelligenceBatchOffset,
    }),
    { downstream: true, budgetMs: 75_000 },
  );
  steps.push(intelligence);
  steps.push(await runStep("score", () => scoreProductIntelligence(), { downstream: true, budgetMs: 20_000 }));

  // Reconsider supply verified by earlier patrols too, so a deferred or
  // timed-out patrol does not strand verified supply before the gate.
  const supplyProductIds = supplyItems.map((item) => String(item.productId ?? "")).filter(Boolean);
  // Supply-first CJ products are standalone catalog items, not matches to a
  // marketplace bestseller. Requiring identity_status=linked here silently
  // excluded hundreds of verified, orderable variants marked supply_discovered.
  // Native CJ identity is permitted downstream only when the selector rechecks
  // verified product+variant IDs, shipping, price, inventory, API and orderability.
  const freshSupplyCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const verifiedSupplyPageSize = 100;
  const { count: verifiedSupplyCount, error: verifiedSupplyCountError } = await db
    .from("supplier_listings")
    .select("id", { count: "exact", head: true })
    .eq("supplier", "cj")
    .eq("verification_status", "verified")
    .eq("shipping_status", "verified")
    .eq("price_confirmed", true)
    .eq("inventory_confirmed", true)
    .eq("orderable", true)
    .eq("tracking_available", true)
    .eq("api_available", true)
    .gt("inventory", 0)
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .not("product_id", "is", null)
    .gte("last_verified_at", freshSupplyCutoff);
  if (verifiedSupplyCountError) throw new Error(verifiedSupplyCountError.message);
  const verifiedSupplyPages = Math.max(1, Math.ceil((verifiedSupplyCount ?? 0) / verifiedSupplyPageSize));
  // Rotate on each five-minute patrol so already-published recent offers do not
  // permanently occupy the first page and starve new sellable supplier products.
  const verifiedSupplyOffset = (Math.floor(Date.now() / 300_000) % verifiedSupplyPages) * verifiedSupplyPageSize;
  const { data: verifiedSupply, error: verifiedSupplyError } = await db
    .from("supplier_listings")
    .select("product_id")
    .eq("supplier", "cj")
    .eq("verification_status", "verified")
    .eq("shipping_status", "verified")
    .eq("price_confirmed", true)
    .eq("inventory_confirmed", true)
    .eq("orderable", true)
    .eq("tracking_available", true)
    .eq("api_available", true)
    .gt("inventory", 0)
    .not("supplier_product_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .not("product_id", "is", null)
    .gte("last_verified_at", freshSupplyCutoff)
    .order("last_verified_at", { ascending: false, nullsFirst: false })
    .range(verifiedSupplyOffset, verifiedSupplyOffset + verifiedSupplyPageSize - 1);
  if (verifiedSupplyError) throw new Error(verifiedSupplyError.message);
  const supplyCandidateIds = Array.from(new Set([
    ...listedProductIds,
    ...supplyProductIds,
    ...(verifiedSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
  ]));
  const supplySalesStep = await runStep(
    "supply_sales_test_select",
    () => selectAndPublishSupplySalesTests(supplyCandidateIds, 50, { allowNativeCjIdentity: true }),
    { downstream: true, budgetMs: 20_000 },
  );
  steps.push(supplySalesStep);

  // Only supplier-native CJ offers may enter the sale-selection path.
  // Marketplace bestseller sales tests and NEWFIND delivery are out of scope;
  // this pipeline owns TRACER, BASE, and Shopify only.
  const salesTestStep: PipelineStepResult = {
    name: "sales_test_select",
    ok: true,
    skipped: true,
    retryable: false,
    result: { skipped: true, reason: "marketplace_sourcing_disabled_supplier_native_only" },
  };
  steps.push(salesTestStep);

  steps.push(await runStep("ordering", () => persistReorderRecommendations(), { downstream: true, budgetMs: 15_000 }));
  steps.push(await runStep("test_ready", async () => {
    if (!intelligence.ok) {
      return { skipped: true, reason: "intelligence_step_failed", retryable: intelligence.retryable === true };
    }
    const result = intelligence.result as { testReady?: number } | undefined;
    return { testReady: result?.testReady ?? 0, note: "TEST_READY is produced only after the data quality gate" };
  }, { downstream: true, budgetMs: 2_000 }));

  // A pipeline that completed its code stages is not business-ready if no fresh
  // supplier offer can actually be ordered or no published shop listing is marked
  // orderable. Keep this as a retryable readiness gap (not a code exception) so
  // patrol reports incomplete while continuing independent publication/reconciliation.
  const { count: publishedOrderableListingCount, error: publishedOrderableListingError } = await db
    .from("shop_listings")
    .select("id", { count: "exact", head: true })
    .eq("published", true)
    .eq("orderable", true)
    .gt("inventory", 0);
  if (publishedOrderableListingError) throw new Error(`business readiness listing count failed: ${publishedOrderableListingError.message}`);
  const freshOrderableSupplierCount = verifiedSupplyCount ?? 0;
  const publishedOrderableListings = publishedOrderableListingCount ?? 0;
  const businessReady = freshOrderableSupplierCount > 0 && publishedOrderableListings > 0;
  steps.push({
    name: "business_readiness",
    ok: true,
    skipped: !businessReady,
    retryable: !businessReady,
    result: {
      ready: businessReady,
      freshOrderableSuppliers: freshOrderableSupplierCount,
      publishedOrderableListings,
      reason: businessReady
        ? null
        : freshOrderableSupplierCount === 0
          ? "no_fresh_verified_orderable_supplier"
          : "no_published_orderable_listing",
    },
  });

  // Marketplace ranking pages are demand observations, not supplier catalogs.
  // Do not use Yahoo/Amazon/Rakuten ranking rows or their barcodes to drive
  // procurement matching. CJ procurement is handled by the dedicated
  // supply-first path, which verifies the exact CJ product/variant, price,
  // stock, Japan shipping, orderability, and tracking directly.
  steps.push({
    name: "dropship",
    ok: true,
    skipped: true,
    retryable: false,
    result: {
      skipped: true,
      reason: "marketplace_rankings_not_used_for_supplier_procurement",
      discoveryCron: "/api/cron/supply-first",
    },
  });


  const blockingFailed = steps.some((step) => !step.ok && !step.skipped);
  const deferredStep = steps.find((step) => {
    if (!step.skipped) return false;
    // Market discovery and supplier discovery are enrichment inputs, not
    // prerequisites for processing already-persisted supply candidates. If a
    // marketplace source lacks child-variant evidence or CJ is in quota cooldown,
    // record the coverage gap and retry on a later patrol; do not mark the core
    // supply-first sales cycle incomplete when its downstream steps ran.
    const optionalDiscoverySteps = new Set(["bestsellers", "auxiliary_trends", "supply", "supply_first", "dropship"]);
    if (optionalDiscoverySteps.has(step.name) && step.retryable === true) return false;
    // Identity re-verification is also a bounded background enrichment step.
    // The cursor resumes on a later patrol; unresolved identity must still pass
    // the independent native-supplier or canonical-identity sales gate.
    if (step.name === "identity_reverify") return false;
    if (step.retryable === true) return true;
    const reason =
      step.result &&
      typeof step.result === "object" &&
      "reason" in step.result
        ? String((step.result as { reason?: unknown }).reason ?? "")
        : "";
    return reason === "deferred_to_next_patrol_time_budget" ||
      reason === "step_time_budget_exceeded_deferred" ||
      reason === "previous_step_timeout_stops_pipeline" ||
      reason === "gemini_not_configured_candidate_resolution_blocked" ||
      reason === "gemini_failed" ||
      reason === "supplier_quota_cooldown";
  });
  // A run can finish executing its available stages while the business flow is
  // still degraded because discovery was deferred. Do not report "complete"
  // when a retryable discovery stage was skipped: production patrol previously
  // reported complete with zero orderable suppliers and zero published listings.
  const retryableDiscoveryDeferred = steps.some((step) =>
    step.skipped === true &&
    step.retryable === true &&
    ["bestsellers", "supply", "supply_first", "dropship"].includes(step.name),
  );
  const incomplete = pipelineTimedOut || Boolean(deferredStep) || retryableDiscoveryDeferred;
  return {
    ok: !blockingFailed && !incomplete,
    complete: !incomplete && steps.every((step) => step.ok),
    steps,
  };
}
