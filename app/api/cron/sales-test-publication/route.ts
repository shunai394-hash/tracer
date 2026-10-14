import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";
import { recoverStaleCronRun } from "@/lib/ops/cron-lock";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";
import { evaluateChannelDeliveryHealth } from "@/lib/market/channel-delivery-health";

export const runtime = "nodejs";
export const maxDuration = 300;

async function buildOpportunityInBatches(productIds: string[], batchSize = 15) {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  let processed = 0;
  let upserted = 0;
  let testReady = 0;
  let rejected = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const result = await buildOpportunityIntelligence({
      productIds: ids.slice(i, i + batchSize),
      batchSize,
    });
    processed += result.processed;
    upserted += result.upserted;
    testReady += result.testReady;
    rejected += result.rejected;
  }
  return { processed, upserted, testReady, rejected };
}

async function promoteGatePassedListings(selectedListingIds: string[]) {
  // Delivery channels are independent: a Shopify/BASE outage must not suppress
  // another channel. Persist whole-call failures so the next reconciliation run
  // can retry the failed channel instead of leaving an apparently healthy row.
  const supabase = createSupabaseAdminClient();
  const shopify = await syncPublishedListingsToShopify(selectedListingIds).catch(async (error) => {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const { error: persistError } = await supabase.from("shop_listings").update({
      shopify_sync_status: "failed",
      shopify_sync_error: message,
      shopify_last_error: message,
      updated_at: new Date().toISOString(),
    }).in("id", selectedListingIds);
    return {
      configured: true,
      attempted: selectedListingIds.length,
      synced: 0,
      failed: selectedListingIds.map((listingId) => ({
        listingId,
        error: persistError ? `${message};shopify_failure_state_persist_failed:${persistError.message}`.slice(0, 2000) : message,
      })),
      listingIds: [] as string[],
      error: message,
    };
  });
  const publishedListingIds = shopify.listingIds;
  const base = await publishPublishedListingsToBase(400, selectedListingIds).catch(async (error) => {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const { error: persistError } = await supabase.from("shop_listings").update({
      base_publication_status: "failed",
      base_publication_lease_until: null,
      base_last_error: message,
      updated_at: new Date().toISOString(),
    }).in("id", selectedListingIds);
    return {
      ok: false,
      results: selectedListingIds.map((listingId) => ({
        ok: false,
        listingId,
        baseItemId: null,
        error: persistError ? `${message};base_failure_state_persist_failed:${persistError.message}`.slice(0, 2000) : message,
      })),
      error: message,
    };
  });
  const newfind = await Promise.all(
    selectedListingIds.map((listingId) => promoteShopListingToNewfind(listingId).catch((error) => ({
      configured: true,
      sent: false,
      eventId: `tracer-shop-listing:${listingId}`,
      status: null,
      ackStatus: null,
      detail: error instanceof Error ? error.message : String(error),
    }))),
  );
  return {
    shopify,
    publishedListingIds,
    base,
    baseReady: base.results.filter((result) => result.ok && result.baseItemId).map((result) => result.listingId),
    newfind,
  };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const searchParams = new URL(request.url).searchParams;
  const requestedDryRunLimit = Number(searchParams.get("limit") ?? 100);
  const dryRunLimit = Number.isFinite(requestedDryRunLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedDryRunLimit)))
    : 100;
  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
    if (!dryRun) {
      await recoverStaleCronRun(supabase, "sales-test-publication", maxDuration);
      const { data: cronRun, error: claimError } = await supabase
        .from("cron_runs")
        .insert({ job_name: "sales-test-publication", status: "running", metadata: { phase: "sales_test_publication" } })
        .select("id")
        .single();
      if (claimError) {
        if (claimError.code === "23505") return NextResponse.json({ ok: true, skipped: true, reason: "cron_already_running", job: "sales-test-publication" }, { status: 409 });
        throw new Error(claimError.message);
      }
      cronRunId = cronRun?.id ? String(cronRun.id) : null;
    }

    // Consume only identifier-grade linked supply. CJ is a supported supply
    // source; payment automation remains an order-time concern and never
    // suppresses a listing that has already passed the publication gate.
    const { data: demandSupply, error: demandSupplyError } = await supabase
      .from("demand_cj_products")
      .select("product_id")
      .not("product_id", "is", null)
      .limit(1000);
    if (demandSupplyError) throw new Error(demandSupplyError.message);

    const { data: verifiedSupply, error: verifiedSupplyError } = await supabase
      .from("supplier_listings")
      .select("product_id")
      .in("supplier", ["cj", "cjdropshipping", "orosy", "faire", "dsers"])
      .eq("verification_status", "verified")
      .eq("identity_status", "linked")
      .eq("orderable", true)
      .eq("inventory_confirmed", true)
      .gt("inventory", 0)
      .not("product_id", "is", null)
      .order("last_verified_at", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (verifiedSupplyError) throw new Error(verifiedSupplyError.message);

    // CJ-native supply is its own evidence path: exact supplier product + variant,
    // verified shipping, price, stock, orderability, tracking and API availability.
    // It does not need a marketplace ASIN/JAN match. The strict native-CJ
    // evidence gate remains mandatory for both dry-run and live publication.
    const { data: nativeCjSupply, error: nativeCjSupplyError } = await supabase
      .from("supplier_listings")
      .select("product_id")
      .in("supplier", ["cj", "cjdropshipping"])
      .eq("verification_status", "verified")
      .in("shipping_status", ["verified", "estimated"])
      .eq("price_confirmed", true)
      .eq("inventory_confirmed", true)
      .gt("inventory", 0)
      .eq("orderable", true)
      .eq("tracking_available", true)
      .eq("api_available", true)
      .not("supplier_product_id", "is", null)
      .not("supplier_variant_id", "is", null)
      .not("product_id", "is", null)
      .order("last_verified_at", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (nativeCjSupplyError) throw new Error(nativeCjSupplyError.message);

    const verifiedSupplyIds = Array.from(new Set([
      ...(demandSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
      ...(verifiedSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
      ...(nativeCjSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
    ]));
    // The read-only audit is bounded before any intelligence queries, and
    // prioritizes verified native CJ evidence so it stays inside request limits.
    const nativeCjProductIds = (nativeCjSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean);
    const dryRunProductIds = Array.from(new Set([
      ...nativeCjProductIds,
      ...(demandSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
      ...(verifiedSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
    ])).slice(0, dryRunLimit);
    const candidateProductIds = dryRun ? dryRunProductIds : verifiedSupplyIds;
    // Repair only the missing-intelligence subset for canonical supply. Do not
    // rebuild already-enriched products: this keeps the publication path bounded
    // while preventing verified supply from being permanently rejected merely
    // because an earlier patrol timed out before writing opportunity_intelligence.
    const opportunityProductIds = new Set<string>();
    const canonicalProductIds = new Set<string>();
    for (let i = 0; i < candidateProductIds.length; i += 100) {
      const ids = candidateProductIds.slice(i, i + 100);
      const [opportunityResult, canonicalResult] = await Promise.all([
        supabase.from("opportunity_intelligence").select("product_id").in("product_id", ids),
        supabase.from("product_intelligence").select("product_id").in("product_id", ids),
      ]);
      if (opportunityResult.error) throw new Error(opportunityResult.error.message);
      if (canonicalResult.error) throw new Error(canonicalResult.error.message);
      for (const row of opportunityResult.data ?? []) opportunityProductIds.add(String(row.product_id));
      for (const row of canonicalResult.data ?? []) canonicalProductIds.add(String(row.product_id));
    }
    const missingOpportunityIds = candidateProductIds.filter(
      (id) => canonicalProductIds.has(id) && !opportunityProductIds.has(id),
    );
    if (missingOpportunityIds.length > 0 && !dryRun) {
      await buildOpportunityInBatches(missingOpportunityIds.slice(0, 30), 10);
    }
    // Native CJ products can be listed as their own catalog identity once the
    // exact product+variant, JP shipping, current stock, API orderability,
    // tracking, Japanese content, image, and positive contribution profit pass.
    // Keep live writes deliberately small; repeated patrols advance the queue.
    // Native CJ catalog items are eligible for the strict evidence gate on live runs;
    // do not require a separate feature flag unrelated to supplier evidence.
    const supplySelected = await selectAndPublishSupplySalesTests(candidateProductIds, dryRun ? 100 : 50, {
      dryRun,
      allowNativeCjIdentity: true,
    });
    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        noWrites: true,
        mode: "canonical_supply_fast_path",
        nativeCjIdentityUsesStrictEvidenceGate: true,
        supplySelected,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (supplySelected.published > 0) {
      const downstream = await promoteGatePassedListings(supplySelected.selectedListingIds);
      const channelHealth = evaluateChannelDeliveryHealth({ selectedCount: supplySelected.selectedListingIds.length, shopify: { configured: downstream.shopify.configured, attempted: downstream.shopify.attempted, synced: downstream.shopify.synced, failedCount: downstream.shopify.failed.length }, base: downstream.base });
      if (cronRunId) await supabase.from("cron_runs").update({
        status: channelHealth.ok ? "succeeded" : "failed",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: supplySelected.considered,
        failed: channelHealth.failedCount,
        metadata: {
          phase: "sales_test_publication",
          mode: "canonical_supply_fast_path",
          considered: supplySelected.considered,
          published: supplySelected.published,
          downstream: {
            selected: supplySelected.selectedListingIds.length,
            shopifyOk: downstream.shopify.configured === true && downstream.shopify.failed.length === 0,
            shopifyError: "error" in downstream.shopify ? downstream.shopify.error : downstream.shopify.failed.map((item) => item.error).slice(0, 10),
            baseOk: downstream.base.results.length === supplySelected.selectedListingIds.length && downstream.base.results.every((item) => item.ok && Boolean(item.baseItemId)),
            baseError: "error" in downstream.base ? downstream.base.error : downstream.base.results.filter((item) => !item.ok).slice(0, 10),
            newfindSent: downstream.newfind.filter((item) => item.sent).length,
          },
        },
      }).eq("id", cronRunId);
      return NextResponse.json({
        ok: channelHealth.ok,
        phase: "sales_test_publication",
        elapsedMs: Date.now() - startedAt,
        mode: "canonical_supply_fast_path",
        supplySelected,
        downstream,
        channelHealth,
      }, { status: channelHealth.ok ? 200 : 207 });
    }

    const { data: readyRows, error: readyError } = await supabase
      .from("marketplace_bestsellers")
      .select("id,product_id")
      .eq("pipeline_stage", "VARIANT_VERIFIED")
      .eq("pipeline_status", "ready")
      .not("product_id", "is", null)
      .order("fetched_at", { ascending: false })
      .limit(400);
    if (readyError) throw new Error(readyError.message);
    const candidateIds = (readyRows ?? []).map((row) => String(row.id));
    const marketProductIds = Array.from(new Set((readyRows ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean)));
    if (marketProductIds.length > 0) await buildOpportunityInBatches(marketProductIds, 10);
    const decision = await selectAndPublishSalesTests(candidateIds, 400);
    const downstream = await promoteGatePassedListings(decision.selectedListingIds);
    const channelHealth = evaluateChannelDeliveryHealth({ selectedCount: decision.selectedListingIds.length, shopify: { configured: downstream.shopify.configured, attempted: downstream.shopify.attempted, synced: downstream.shopify.synced, failedCount: downstream.shopify.failed.length }, base: downstream.base });

    if (cronRunId) await supabase.from("cron_runs").update({
      status: channelHealth.ok ? "succeeded" : "failed",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      processed: supplySelected.considered + candidateIds.length,
      failed: channelHealth.failedCount,
      metadata: { phase: "sales_test_publication", mode: "market_linked_sales_test", supplyConsidered: supplySelected.considered, supplyPublished: supplySelected.published, supplyRejected: supplySelected.rejected.length, supplyRejectedReasons: supplySelected.rejected.reduce<Record<string, number>>((counts, item) => { for (const reason of item.reasons) counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {}), supplyRejectedSample: supplySelected.rejected.slice(0, 20), considered: decision.considered, published: decision.published, shopify: downstream.shopify },
    }).eq("id", cronRunId);

    return NextResponse.json({ ok: channelHealth.ok, phase: "sales_test_publication", elapsedMs: Date.now() - startedAt, mode: "market_linked_sales_test", candidateCount: candidateIds.length, decision, downstream, channelHealth, nextPhase: "downstream_delivery" }, { status: channelHealth.ok ? 200 : 207 });
  } catch (error) {
    if (cronRunId) {
      try { await supabase.from("cron_runs").update({ status: "failed", finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }).eq("id", cronRunId); } catch (recordError) { console.error("[TRACER CRON RUN RECORD ERROR]", recordError); }
    }
    console.error("[TRACER SALES TEST PUBLICATION CRON ERROR]", error);
    return NextResponse.json({ ok: false, phase: "sales_test_publication", error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
