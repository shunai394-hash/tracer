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
  // NEWFIND promotion or change the canonical TRACER publication result.
  const shopify = await syncPublishedListingsToShopify(selectedListingIds).catch((error) => ({
    ok: false,
    listingIds: [] as string[],
    error: error instanceof Error ? error.message : String(error),
  }));
  const publishedListingIds = shopify.listingIds;
  // Deliver to NEWFIND before BASE. A BASE image/API failure must not overwrite
  // the durable Sales Test Gate provenance before another channel can use it.
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
  const base = await publishPublishedListingsToBase(400, selectedListingIds).catch((error) => ({
    ok: false,
    results: [] as Array<{ ok: boolean; baseItemId?: string | null; listingId: string; error?: string }>,
    error: error instanceof Error ? error.message : String(error),
  }));
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
      .in("supplier", ["cj", "cjdropshipping", "faire", "dsers"])
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
    // It does not need a marketplace ASIN/JAN match. Live publication is enabled
    // by default when these evidence gates pass; the explicit "false" value is
    // an emergency kill switch, not a required opt-in.
    const nativeSupplyFreshCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const nativeSupplyFutureCutoff = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { data: nativeCjSupply, error: nativeCjSupplyError } = await supabase
      .from("supplier_listings")
      .select("product_id")
      .in("supplier", ["cj", "cjdropshipping"])
      .eq("identity_status", "supply_discovered")
      .eq("verification_status", "verified")
      .eq("shipping_status", "verified")
      .eq("configured", true)
      .eq("ship_to", "JP")
      .eq("price_confirmed", true)
      .eq("inventory_confirmed", true)
      .gt("inventory", 0)
      .gt("cost", 0)
      .gte("shipping_cost", 0)
      .eq("orderable", true)
      .eq("tracking_available", true)
      .eq("api_available", true)
      .gte("last_verified_at", nativeSupplyFreshCutoff)
      .lte("last_verified_at", nativeSupplyFutureCutoff)
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
    // CJ-native catalog products are valid first-party supplier identities when the exact
    // supplier product + variant, stock, price, JP delivery, tracking, orderability and
    // positive contribution profit all pass the downstream gate. Do not require an
    // unrelated marketplace-identity feature flag to publish them. Set the env var to
    // "false" only as an emergency kill switch.
    const allowNativeCjIdentity = dryRun || process.env.TRACER_CJ_NATIVE_SUPPLY_PUBLICATION_ENABLED !== "false";
    const supplySelected = await selectAndPublishSupplySalesTests(candidateProductIds, dryRun ? 50 : 400, {
      dryRun,
      allowNativeCjIdentity,
    });
    if (dryRun) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        noWrites: true,
        mode: "canonical_supply_fast_path",
        nativeCjPublicationEnabledForLiveRuns: allowNativeCjIdentity,
        supplySelected,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    if (supplySelected.published > 0) {
      const downstream = await promoteGatePassedListings(supplySelected.selectedListingIds);
      if (cronRunId) await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: supplySelected.considered,
        failed: 0,
        metadata: {
          phase: "sales_test_publication",
          mode: "canonical_supply_fast_path",
          considered: supplySelected.considered,
          published: supplySelected.published,
          downstream: {
            selected: supplySelected.selectedListingIds.length,
            shopifyOk: !("error" in downstream.shopify),
            shopifyError: "error" in downstream.shopify ? downstream.shopify.error : null,
            baseOk: !("error" in downstream.base),
            baseError: "error" in downstream.base ? downstream.base.error : null,
            newfindSent: downstream.newfind.filter((item) => item.sent).length,
          },
        },
      }).eq("id", cronRunId);
      return NextResponse.json({
        ok: true,
        phase: "sales_test_publication",
        elapsedMs: Date.now() - startedAt,
        mode: "canonical_supply_fast_path",
        supplySelected,
        downstream,
      });
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

    if (cronRunId) await supabase.from("cron_runs").update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      processed: supplySelected.considered + candidateIds.length,
      failed: 0,
      metadata: { phase: "sales_test_publication", mode: "canonical_supply_fast_path", supplyConsidered: supplySelected.considered, supplyPublished: supplySelected.published, supplyRejected: supplySelected.rejected.length, supplyRejectedReasons: supplySelected.rejected.reduce<Record<string, number>>((counts, item) => { for (const reason of item.reasons) counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {}), supplyRejectedSample: supplySelected.rejected.slice(0, 20), considered: decision.considered, published: decision.published, shopify: downstream.shopify },
    }).eq("id", cronRunId);

    return NextResponse.json({ ok: true, phase: "sales_test_publication", elapsedMs: Date.now() - startedAt, mode: "canonical_supply_fast_path", candidateCount: candidateIds.length, decision, downstream, nextPhase: "downstream_delivery" });
  } catch (error) {
    if (cronRunId) {
      try { await supabase.from("cron_runs").update({ status: "failed", finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }).eq("id", cronRunId); } catch (recordError) { console.error("[TRACER CRON RUN RECORD ERROR]", recordError); }
    }
    console.error("[TRACER SALES TEST PUBLICATION CRON ERROR]", error);
    return NextResponse.json({ ok: false, phase: "sales_test_publication", error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
