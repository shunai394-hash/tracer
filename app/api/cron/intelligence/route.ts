import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runIntelligencePipeline } from "@/lib/intelligence/run-intelligence-pipeline";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";

export const runtime = "nodejs";
export const maxDuration = 300;

async function canonicalSupplyRecovery() {
  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from("supplier_listings")
    .select("product_id")
    .eq("supplier", "cj")
    .eq("verification_status", "verified")
    .eq("identity_status", "linked")
    .eq("orderable", true)
    .eq("inventory_confirmed", true)
    .gt("inventory", 0)
    .eq("tracking_available", true)
    .eq("api_available", true)
    .not("product_id", "is", null)
    .order("last_verified_at", { ascending: false, nullsFirst: false })
    .limit(25);
  if (error) throw new Error(error.message);

  const productIds = Array.from(new Set((data ?? []).map((row) => String(row.product_id ?? "")).filter(Boolean)));
  if (productIds.length === 0) return { considered: 0, published: 0, synced: 0, reason: "no_canonical_cj_supply" };

  const intelligence = await buildOpportunityIntelligence({ productIds });
  const selected = await selectAndPublishSupplySalesTests(productIds, 10);
  const shopify = selected.publishedListingIds.length > 0
    ? await syncPublishedListingsToShopify(selected.publishedListingIds)
    : { attempted: 0, synced: 0, failed: 0, listingIds: [] };

  return {
    considered: productIds.length,
    intelligenceProcessed: intelligence.processed,
    testReady: intelligence.testReady,
    published: selected.published,
    publishedListingIds: selected.publishedListingIds,
    synced: shopify.synced,
    shopifyFailed: shopify.failed,
  };
}

export async function GET(request: Request) {
  try {
    const authError = await requireAutomationAuth(request);
    if (authError) return authError;

    const recovery = await canonicalSupplyRecovery();
    const result = await runIntelligencePipeline({ deadlineAt: Date.now() + 210_000 });

    return NextResponse.json({
      ok: true,
      complete: result.complete,
      isolated: result.ok,
      canonicalSupplyRecovery: recovery,
      steps: result.steps,
    });
  } catch (error) {
    console.error("[TRACER INTELLIGENCE CRON ERROR]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
