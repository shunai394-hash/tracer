import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { runIntelligencePipeline } from "@/lib/intelligence/run-intelligence-pipeline";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";
import { rescueUndeliveredGatePassedListings, retryPendingNewfindPromotions } from "@/lib/integration/newfind";
import { catalogCountsNeedReview } from "@/lib/ops/catalog-count-check";
import { promoteCommerceListingsToNewfind } from "@/lib/integration/newfind-commerce";
import { isCanonicalCjNativeId } from "@/lib/commerce/core";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { MINIMUM_EXPECTED_PROFIT_JPY } from "@/lib/commerce/profit-floor.mjs";

export const runtime = "nodejs";
export const maxDuration = 300;

type Snapshot = {
  products: number;
  supplierListings: number;
  orderableSuppliers: number;
  shopListings: number;
  publishedListings: number;
  eligibleForBase: number;
  legacyEligibleForBase: number;
  newEligibleForBase: number;
  newEligibleForShopify: number;
  autoProcurementEligibleListings: number;
  onBase: number;
  basePublished: number;
  orders: number;
  commerceProducts: number;
  commerceVariants: number;
  verifiedCommerceOffers: number;
  publishedCommerceListings: number;
  publishedBaseCommerceListings: number;
  publishedShopifyCommerceListings: number;
  unpublishedCommerceListings: number;
  commerceOrders: number;
  supplierProcurementOrders: number;
  trackingWritebackOrders: number;
};

async function snapshot(db: ReturnType<typeof createSupabaseAdminClient>): Promise<Snapshot> {
  const productsQuery = db.from("products").select("*", { count: "exact", head: true });
  const supplierListingsQuery = db.from("supplier_listings").select("*", { count: "exact", head: true });
  const orderableSuppliersQuery = db.from("supplier_listings").select("*", { count: "exact", head: true }).eq("orderable", true);
  const shopListingsQuery = db.from("shop_listings").select("*", { count: "exact", head: true });
  const publishedListingsQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).eq("published", true);
  const eligibilityListingsQuery = db.from("shop_listings").select("supplier_name,orderable,inventory,image_url,tracking_available,pipeline_reason,pipeline_stage,pipeline_status").eq("published", true);
  // The clean commerce catalog is the source of truth for BASE/Shopify. Keep
  // legacy shop_listings eligibility separate so a legacy reset cannot report
  // zero sellable variants when the canonical catalog has verified offers.
  const commerceEligibilityQuery = db.from("commerce_variants")
    .select("id,title_ja,commerce_products!inner(active,image_url),supplier_offers!inner(id,supplier_code,supplier_product_id,supplier_variant_id,unit_cost,shipping_cost,inventory,ship_to,tracking_supported,source_status,last_checked_at),commerce_prices!inner(supplier_offer_id,currency,selling_price,expected_profit)")
    .eq("commerce_products.active", true)
    .eq("supplier_offers.ship_to", "JP")
    .eq("supplier_offers.source_status", "verified")
    .eq("supplier_offers.tracking_supported", true)
    .gte("supplier_offers.last_checked_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    .gt("supplier_offers.inventory", 0)
    .gt("supplier_offers.unit_cost", 0)
    .gt("supplier_offers.shipping_cost", 0)
    .eq("commerce_prices.currency", "JPY")
    .gt("commerce_prices.selling_price", 0)
    .gte("commerce_prices.expected_profit", MINIMUM_EXPECTED_PROFIT_JPY);
  const publishedBaseVariantIdsQuery = db.from("channel_listings").select("variant_id")
    .eq("channel", "base").eq("status", "published");
  const publishedShopifyVariantIdsQuery = db.from("channel_listings").select("variant_id")
    .eq("channel", "shopify").eq("status", "published");
  const onBaseQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).not("base_item_id", "is", null);
  const basePublishedQuery = db.from("shop_listings").select("*", { count: "exact", head: true }).not("base_item_id", "is", null).eq("base_publication_status", "published").eq("published", true);
  const ordersQuery = db.from("shop_orders").select("*", { count: "exact", head: true });
  const commerceProductsQuery = db.from("commerce_products").select("*", { count: "exact", head: true });
  const commerceVariantsQuery = db.from("commerce_variants").select("*", { count: "exact", head: true });
  const freshCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const verifiedCommerceOffersQuery = db.from("supplier_offers").select("*", { count: "exact", head: true })
    .eq("source_status", "verified").eq("tracking_supported", true).eq("ship_to", "JP")
    .gt("inventory", 0).gte("last_checked_at", freshCutoff);
  const publishedCommerceListingsQuery = db.from("channel_listings").select("*", { count: "exact", head: true }).eq("status", "published");
  const publishedBaseCommerceListingsQuery = db.from("channel_listings").select("*", { count: "exact", head: true }).eq("channel", "base").eq("status", "published");
  const publishedShopifyCommerceListingsQuery = db.from("channel_listings").select("*", { count: "exact", head: true }).eq("channel", "shopify").eq("status", "published");
  const unpublishedCommerceListingsQuery = db.from("channel_listings").select("*", { count: "exact", head: true }).neq("status", "published");
  const commerceOrdersQuery = db.from("commerce_orders").select("*", { count: "exact", head: true });
  const supplierProcurementOrdersQuery = db.from("procurement_orders").select("*", { count: "exact", head: true });
  // Count only paid orders whose successful channel fulfillment writeback marker was persisted.
  const baseTrackingWritebackQuery = db.from("commerce_orders").select("*", { count: "exact", head: true })
    .eq("channel", "base").eq("payment_status", "paid")
    .not("raw_payload->tracerBaseFulfillmentGroups", "is", null);
  const shopifyTrackingWritebackQuery = db.from("commerce_orders").select("*", { count: "exact", head: true })
    .eq("channel", "shopify").eq("payment_status", "paid")
    .not("raw_payload->tracerShopifyFulfillmentGroups", "is", null);

  const [productsResult, supplierListingsResult, orderableSuppliersResult, shopListingsResult, publishedListingsResult, eligibilityListingsResult, commerceEligibilityResult, publishedBaseVariantIdsResult, publishedShopifyVariantIdsResult, onBaseResult, basePublishedResult, ordersResult, commerceProductsResult, commerceVariantsResult, verifiedCommerceOffersResult, publishedCommerceListingsResult, publishedBaseCommerceListingsResult, publishedShopifyCommerceListingsResult, unpublishedCommerceListingsResult, commerceOrdersResult, supplierProcurementOrdersResult, baseTrackingWritebackResult, shopifyTrackingWritebackResult] =
    await Promise.all([productsQuery, supplierListingsQuery, orderableSuppliersQuery, shopListingsQuery, publishedListingsQuery, eligibilityListingsQuery, commerceEligibilityQuery, publishedBaseVariantIdsQuery, publishedShopifyVariantIdsQuery, onBaseQuery, basePublishedQuery, ordersQuery, commerceProductsQuery, commerceVariantsQuery, verifiedCommerceOffersQuery, publishedCommerceListingsQuery, publishedBaseCommerceListingsQuery, publishedShopifyCommerceListingsQuery, unpublishedCommerceListingsQuery, commerceOrdersQuery, supplierProcurementOrdersQuery, baseTrackingWritebackQuery, shopifyTrackingWritebackQuery]);

  const results = [
    ["products", productsResult], ["supplier_listings", supplierListingsResult], ["supplier_listings(orderable)", orderableSuppliersResult],
    ["shop_listings", shopListingsResult], ["shop_listings(published)", publishedListingsResult], ["shop_listings(eligibility)", eligibilityListingsResult],
    ["commerce_variants(eligibility)", commerceEligibilityResult],
    ["channel_listings(base_variant_ids)", publishedBaseVariantIdsResult],
    ["channel_listings(shopify_variant_ids)", publishedShopifyVariantIdsResult],
    ["shop_listings(on_base)", onBaseResult], ["shop_listings(base_published)", basePublishedResult], ["shop_orders", ordersResult],
    ["commerce_products", commerceProductsResult], ["commerce_variants", commerceVariantsResult],
    ["supplier_offers(verified_fresh)", verifiedCommerceOffersResult], ["channel_listings(published)", publishedCommerceListingsResult],
    ["channel_listings(base_published)", publishedBaseCommerceListingsResult], ["channel_listings(shopify_published)", publishedShopifyCommerceListingsResult],
    ["channel_listings(unpublished)", unpublishedCommerceListingsResult],
    ["commerce_orders", commerceOrdersResult], ["procurement_orders", supplierProcurementOrdersResult],
    ["commerce_orders(base_tracking_writeback)", baseTrackingWritebackResult],
    ["commerce_orders(shopify_tracking_writeback)", shopifyTrackingWritebackResult],
  ] as const;

  for (const [label, result] of results) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  const legacyEligibleRows = (eligibilityListingsResult.data ?? []).filter((row) => {
    const inventory = Number(row.inventory);
    return row.orderable === true &&
      Number.isFinite(inventory) &&
      inventory > 0 &&
      row.image_url !== null &&
      row.image_url !== "" &&
      row.tracking_available === true &&
      ["PUBLISHED", "BASE_PUBLISHED", "SHOPIFY_PUBLISHED"].includes(String(row.pipeline_stage ?? "")) &&
      row.pipeline_status === "published" &&
      ["sales_test_gate_passed", "profitable_supplier_linked_catalog"].includes(String(row.pipeline_reason ?? ""));
  });

  const relationRows = (value: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
    return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
  };
  const eligibleVariantIds = new Set<string>();
  for (const row of commerceEligibilityResult.data ?? []) {
    const product = relationRows(row.commerce_products)[0];
    const imageUrl = typeof product?.image_url === "string" ? product.image_url : "";
    if (product?.active !== true || !/^https?:\/\//i.test(imageUrl)) continue;
    if (!isJapaneseProductTitle(String(row.title_ja ?? ""))) continue;
    const offers = relationRows(row.supplier_offers);
    const prices = relationRows(row.commerce_prices);
    const validOffer = offers.find((offer) => {
      const checkedAt = typeof offer.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
      const fresh = Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5 * 60_000 && Date.now() - checkedAt <= 24 * 60 * 60_000;
      const nativeIdsValid = offer.supplier_code !== "cj" ||
        (isCanonicalCjNativeId(offer.supplier_product_id) && isCanonicalCjNativeId(offer.supplier_variant_id));
      return offer.source_status === "verified" && offer.ship_to === "JP" && offer.tracking_supported === true &&
        Number(offer.inventory) > 0 && Number(offer.unit_cost) > 0 && Number(offer.shipping_cost) > 0 && fresh && nativeIdsValid;
    });
    if (!validOffer) continue;
    if (!prices.some((price) => price.supplier_offer_id === validOffer.id && price.currency === "JPY" &&
      Number(price.selling_price) > 0 && Number(price.expected_profit) >= MINIMUM_EXPECTED_PROFIT_JPY)) continue;
    eligibleVariantIds.add(String(row.id));
  }
  const publishedBaseVariantIds = new Set((publishedBaseVariantIdsResult.data ?? []).map((row) => String(row.variant_id)));
  const publishedShopifyVariantIds = new Set((publishedShopifyVariantIdsResult.data ?? []).map((row) => String(row.variant_id)));
  const newEligibleForBase = [...eligibleVariantIds].filter((id) => !publishedBaseVariantIds.has(id)).length;
  const newEligibleForShopify = [...eligibleVariantIds].filter((id) => !publishedShopifyVariantIds.has(id)).length;

  const autoProcurementEligibleRows = (eligibilityListingsResult.data ?? []).filter((row) =>
    getAutoProcurementEligibility(typeof row.supplier_name === "string" ? row.supplier_name : null).eligible
  );

  return {
    products: productsResult.count ?? 0,
    supplierListings: supplierListingsResult.count ?? 0,
    orderableSuppliers: orderableSuppliersResult.count ?? 0,
    shopListings: shopListingsResult.count ?? 0,
    publishedListings: publishedListingsResult.count ?? 0,
    // Canonical eligibility is independent from the legacy sales-test table.
    eligibleForBase: eligibleVariantIds.size,
    legacyEligibleForBase: legacyEligibleRows.length,
    newEligibleForBase,
    newEligibleForShopify,
    autoProcurementEligibleListings: autoProcurementEligibleRows.length,
    onBase: onBaseResult.count ?? 0,
    basePublished: basePublishedResult.count ?? 0,
    orders: ordersResult.count ?? 0,
    commerceProducts: commerceProductsResult.count ?? 0,
    commerceVariants: commerceVariantsResult.count ?? 0,
    verifiedCommerceOffers: verifiedCommerceOffersResult.count ?? 0,
    publishedCommerceListings: publishedCommerceListingsResult.count ?? 0,
    publishedBaseCommerceListings: publishedBaseCommerceListingsResult.count ?? 0,
    publishedShopifyCommerceListings: publishedShopifyCommerceListingsResult.count ?? 0,
    unpublishedCommerceListings: unpublishedCommerceListingsResult.count ?? 0,
    commerceOrders: commerceOrdersResult.count ?? 0,
    supplierProcurementOrders: supplierProcurementOrdersResult.count ?? 0,
    trackingWritebackOrders: (baseTrackingWritebackResult.count ?? 0) + (shopifyTrackingWritebackResult.count ?? 0),
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

async function withinBudget<T>(work: Promise<T>, deadlineAt: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}_deferred_time_budget`)),
          Math.max(1_000, deadlineAt - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const startedAt = Date.now();
  let cronId: string | null = null;

  try {
    // The patrol can legitimately run for up to 300s. Reclaiming after 90s
    // could start a second patrol while the first is still doing live supplier
    // checks, creating duplicate writes and competing publication decisions.
    // Keep the recovery threshold above maxDuration with a safety margin.
    await recoverStaleCronRun(db, "patrol-ai", 360);
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
    const priorRuns = await db
      .from("cron_runs")
      .select("metadata,started_at")
      .eq("job_name", "patrol-ai")
      .in("status", ["succeeded", "failed"])
      .order("started_at", { ascending: false })
      .limit(20);
    if (priorRuns.error) throw new Error(`patrol prior snapshot lookup failed: ${priorRuns.error.message}`);
    let previous: { shopListings: number; supplierListings: number } | null = null;
    for (const row of priorRuns.data ?? []) {
      const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata as Record<string, unknown>
        : {};
      const after = metadata.after && typeof metadata.after === "object" && !Array.isArray(metadata.after)
        ? metadata.after as Record<string, unknown>
        : null;
      const shopListings = after && typeof after.shopListings === "number" ? after.shopListings : null;
      const supplierListings = after && typeof after.supplierListings === "number" ? after.supplierListings : null;
      if (shopListings !== null && supplierListings !== null) {
        previous = { shopListings, supplierListings };
        break;
      }
    }
    if (catalogCountsNeedReview(
      { shopListings: before.shopListings, supplierListings: before.supplierListings },
      previous,
    )) {
      const reason = "catalog_count_drop_requires_manual_review";
      const report = {
        ok: false,
        status: "failed",
        decision: "catalog_count_safety_stop",
        before,
        previous,
        message: "カタログ件数の急減を検出したため、データ破損や誤削除の可能性を確認するまで自動処理を停止しました。",
        errors: [reason],
      };
      const { error: persistError } = await db.from("cron_runs").update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: 0,
        failed: 1,
        status: "failed",
        error: reason,
        metadata: report,
      }).eq("id", cronId);
      if (persistError) throw new Error(`catalog safety stop persistence failed: ${persistError.message}`);
      console.error("[TRACER PATROL CATALOG SAFETY STOP]", JSON.stringify({
        current: { shopListings: before.shopListings, supplierListings: before.supplierListings },
        previous,
      }));
      return NextResponse.json(report, { status: 503 });
    }
    console.log("[TRACER PATROL AI START]", JSON.stringify({ before }));

    // The patrol must always execute the canonical full intelligence loop.
    // AI patrol must not choose a shallow repair path that bypasses Market,
    // Identity, Demand, Supply, Opportunity, and the Sales Test Gate.
    // BASE and Shopify publication run through their canonical commerce crons.
    // Leave room for NEWFIND rescue and cron_runs bookkeeping; deferred stages resume next patrol.
    const pipeline = await runIntelligencePipeline({
      deadlineAt: startedAt + 270_000,
      // Heartbeat: if Vercel still kills the function, the lock row shows the
      // step that was running instead of an empty "starting" phase.
      onStep: async (step) => {
        if (!cronId) return;
        const { error } = await db.from("cron_runs").update({
          metadata: { actor: "patrol-ai", phase: step, elapsedMs: Date.now() - startedAt },
        }).eq("id", cronId);
        if (error) console.warn("[TRACER PATROL AI HEARTBEAT]", error.message);
      },
    });

    const actions: Array<Record<string, unknown>> = [{
      action: "run_full_intelligence_pipeline",
      result: pipeline,
    }];
    const errors = pipeline.steps
      .filter((step) => !step.ok && !step.skipped)
      .map((step) => `${step.name}: ${step.error ?? "failed"}`);
    const deferredSteps = pipeline.steps
      .filter((step) => step.skipped && step.retryable)
      .map((step) => step.name);
    const technicalDeferredSteps = deferredSteps.filter((name) => name !== "business_readiness");
    const businessReadinessMissing = pipeline.steps.some((step) => step.name === "business_readiness" && step.skipped);

    if (!pipeline.complete) {
      // Discovery incompleteness must not block independent publication of
      // already-linked, in-stock, profitable catalog rows, but a patrol with no
      // verified orderable supplier is not an end-to-end success.
      const incompleteReasons = [
        ...(technicalDeferredSteps.length ? [`deferred=${technicalDeferredSteps.join(",")}`] : []),
        ...(businessReadinessMissing ? ["no_fresh_verified_orderable_supplier"] : []),
      ];
      errors.push(
        incompleteReasons.length
          ? `intelligence_pipeline_incomplete:${incompleteReasons.join(",")}`
          : "intelligence_pipeline_incomplete",
      );
    }

    // Do not publish legacy shop_listings directly to BASE from patrol-ai.
    // That created BASE-only products without matching canonical Shopify IDs.
    // The canonical commerce-publish-base and commerce-publish-shopify crons
    // are the only publication path for newly discovered saleable variants.

    // NEWFIND delivery retries are independent from supplier discovery.
    try {
      const rescue = await rescueUndeliveredGatePassedListings({
        limit: 1,
        deadlineAt: startedAt + 295_000,
      });
      actions.push({ action: "newfind_rescue", result: rescue });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      actions.push({ action: "newfind_rescue", ok: false, error: errors.at(-1) });
    }

    // NEWFIND retries are independent of today's discovery pipeline. A
    // deferred marketplace/CJ enrichment stage must not strand already-published
    // products in the durable failed-delivery queue. The retry helper claims
    // rows with an idempotent lease and rechecks the live UUID product URL.
    if (Date.now() < startedAt + 270_000) {
      try {
        const newfindRetry = await withinBudget(
          retryPendingNewfindPromotions(5),
          startedAt + 285_000,
          "newfind_retry",
        );
        actions.push({ action: "newfind_retry", result: newfindRetry });
      } catch (error) {
        // Keep the canonical patrol result independent from this delivery
        // channel; preserve the exact failure in the durable patrol report.
        actions.push({
          action: "newfind_retry",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      actions.push({ action: "newfind_retry", skipped: true, reason: "time_budget" });
    }

    // Canonical commerce listings (Shopify channel_listings) are not in the
    // shop_listings ledger above; deliver a bounded batch per run with their own ledger.
    // Five concurrent deliveries keep the 500+ item backlog moving without
    // approaching the patrol deadline; the delivery ledger prevents duplicates.
    if (Date.now() < startedAt + 250_000) {
      try {
        const commerceNewfind = await withinBudget(
          promoteCommerceListingsToNewfind({ limit: 5, deadlineAt: startedAt + 285_000 }),
          startedAt + 290_000,
          "newfind_commerce",
        );
        actions.push({ action: "newfind_commerce", result: commerceNewfind });
      } catch (error) {
        actions.push({ action: "newfind_commerce", ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      actions.push({ action: "newfind_commerce", skipped: true, reason: "time_budget" });
    }

    const after = await snapshot(db);
    const progress = {
      newPublishedListings: after.publishedListings - before.publishedListings,
      newBasePublished: after.basePublished - before.basePublished,
      newOrders: after.orders - before.orders,
      newCommercePublishedListings: after.publishedCommerceListings - before.publishedCommerceListings,
      newCommerceOrders: after.commerceOrders - before.commerceOrders,
      newSupplierProcurementOrders: after.supplierProcurementOrders - before.supplierProcurementOrders,
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
      // A completed intelligence pass is not proof of the paid-order → supplier → tracking-writeback chain.
      intelligencePipelineComplete: pipeline.complete,
      endToEndPipelineComplete: after.commerceOrders > 0 && after.supplierProcurementOrders > 0 && after.trackingWritebackOrders > 0,
      orderLifecycleEvidence: {
        commerceOrdersRecorded: after.commerceOrders,
        supplierProcurementOrdersRecorded: after.supplierProcurementOrders,
        trackingWritebackOrdersRecorded: after.trackingWritebackOrders,
        newCommerceOrdersThisRun: progress.newCommerceOrders,
        newSupplierProcurementOrdersThisRun: progress.newSupplierProcurementOrders,
        endToEndOrderFlowObservedThisRun: progress.newCommerceOrders > 0 && progress.newSupplierProcurementOrders > 0,
        endToEndOrderFlowRecorded: after.commerceOrders > 0 && after.supplierProcurementOrders > 0 && after.trackingWritebackOrders > 0,
      },
      // Keep the intelligence job result separate from real commerce readiness.
      // A green patrol is not an end-to-end commerce success until both order and
      // supplier-procurement records exist; do not infer completion from HTTP 200.
      commerceEndToEndComplete: pipeline.complete
        && errors.length === 0
        && after.commerceOrders > 0
        && after.supplierProcurementOrders > 0,
      actions,
      errors,
      message: errors.length
        ? "AI巡回でフルIntelligence Pipelineを実行しましたが、未解決エラーがあります。"
        : progress.newPublishedListings > 0 || progress.newCommercePublishedListings > 0
          ? "AI巡回でフルIntelligence Pipelineを実行し、新規公開まで進みました。"
          : "AI巡回でフルIntelligence Pipelineを実行しました。今回は新規公開条件を満たす商品はありませんでした。",
    };

    const safeSteps = pipeline.steps.map((step) => {
      const raw = step.result && typeof step.result === "object" && !Array.isArray(step.result)
        ? step.result as Record<string, unknown>
        : {};
      const resultSummary: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
          resultSummary[key] = value;
        } else if (Array.isArray(value)) {
          resultSummary[`${key}Count`] = value.length;
        } else if (typeof value === "object") {
          const scalarEntries = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
            .slice(0, 20);
          if (scalarEntries.length > 0) resultSummary[key] = Object.fromEntries(scalarEntries);
        }
      }
      return {
        name: step.name,
        ok: step.ok,
        skipped: step.skipped,
        retryable: step.retryable,
        errorCategory: step.error ? step.error.split(":")[0] : null,
        result: resultSummary,
      };
    });
    const safeReport = {
      ok: report.ok,
      status: report.status,
      durationMs: report.durationMs,
      decision: report.decision,
      before: report.before,
      after: report.after,
      progress: report.progress,
      // Never label the whole sales lifecycle complete from an intelligence pass alone.
      intelligencePipelineComplete: report.intelligencePipelineComplete,
      endToEndPipelineComplete: report.endToEndPipelineComplete,
      orderLifecycleEvidence: report.orderLifecycleEvidence,
      errorCount: errors.length,
      errorCategories: Array.from(new Set(errors.map((error) => error.split(":")[0]))),
      steps: safeSteps,
      actions: actions.map((action) => ({
        action: action.action,
        skipped: action.skipped,
        reason: action.reason,
        attempted: action.attempted,
        published: action.published,
        failed: action.failed,
      })),
    };
    // Keep full detail in the run ledger; production logs contain only bounded counts and stage summaries.
    console.log("[TRACER PATROL AI REPORT]", JSON.stringify(safeReport));

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
// Production deployment sync marker: patrol implementation follows main.
