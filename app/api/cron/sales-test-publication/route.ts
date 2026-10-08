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
  const shopify = await syncPublishedListingsToShopify(selectedListingIds);
  const publishedListingIds = shopify.listingIds;
  const base = await publishPublishedListingsToBase(400, selectedListingIds);
  // NEWFIND is an independent promotion channel. BASE is optional and must not
  // become a hidden prerequisite for distributing a gate-passed TRACER product.
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
  return { shopify, publishedListingIds, base, baseReady: base.results.filter((result) => result.ok && result.baseItemId).map((result) => result.listingId), newfind };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const supabase = createSupabaseAdminClient();
  let cronRunId: string | null = null;
  const startedAt = Date.now();

  try {
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
      .or("identity_status.eq.linked,identity_status.eq.supply_discovered")
      .eq("orderable", true)
      .eq("inventory_confirmed", true)
      .gt("inventory", 0)
      .not("product_id", "is", null)
      .order("last_verified_at", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (verifiedSupplyError) throw new Error(verifiedSupplyError.message);

    const verifiedSupplyIds = Array.from(new Set([
      ...(demandSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
      ...(verifiedSupply ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean),
    ]));
    if (verifiedSupplyIds.length > 0) await buildOpportunityInBatches(verifiedSupplyIds, 50);

    const supplySelected = await selectAndPublishSupplySalesTests(verifiedSupplyIds, 400);
    const supplyDownstream = await promoteGatePassedListings(supplySelected.selectedListingIds);

    if (supplySelected.published > 0) {
      if (cronRunId) await supabase.from("cron_runs").update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        processed: supplySelected.considered,
        failed: 0,
        metadata: { phase: "sales_test_publication", mode: "canonical_supply_intelligence_gate", considered: supplySelected.considered, published: supplySelected.published, shopify: supplyDownstream.shopify },
      }).eq("id", cronRunId);
      return NextResponse.json({ ok: true, phase: "sales_test_publication", elapsedMs: Date.now() - startedAt, mode: "canonical_supply_intelligence_gate", supplySelected, downstream: supplyDownstream, nextPhase: "base_publication" });
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
    if (marketProductIds.length > 0) await buildOpportunityInBatches(marketProductIds, 50);
    const decision = await selectAndPublishSalesTests(candidateIds, 400);
    const downstream = await promoteGatePassedListings(decision.selectedListingIds);

    if (cronRunId) await supabase.from("cron_runs").update({
      status: "succeeded",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      processed: supplySelected.considered + candidateIds.length,
      failed: 0,
      metadata: { phase: "sales_test_publication", mode: "market_linked_sales_test", supplyConsidered: supplySelected.considered, supplyPublished: supplySelected.published, considered: decision.considered, published: decision.published, shopify: downstream.shopify },
    }).eq("id", cronRunId);

    return NextResponse.json({ ok: true, phase: "sales_test_publication", elapsedMs: Date.now() - startedAt, mode: "market_linked_sales_test", candidateCount: candidateIds.length, decision, downstream, nextPhase: "downstream_delivery" });
  } catch (error) {
    if (cronRunId) {
      try { await supabase.from("cron_runs").update({ status: "failed", finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }).eq("id", cronRunId); } catch (recordError) { console.error("[TRACER CRON RUN RECORD ERROR]", recordError); }
    }
    console.error("[TRACER SALES TEST PUBLICATION CRON ERROR]", error);
    return NextResponse.json({ ok: false, phase: "sales_test_publication", error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
