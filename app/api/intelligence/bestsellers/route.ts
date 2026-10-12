import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { buildOpportunityIntelligence } from "@/lib/intelligence/build-opportunity-intelligence";
import { filterSupplierCandidateIds } from "@/lib/intelligence/filter-supplier-candidates";
import { promoteShopListingToNewfind } from "@/lib/integration/newfind";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

export const runtime = "nodejs";
export const maxDuration = 60;


export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();

    // 1. Persist demand candidates.
    const bestsellers = await persistMarketplaceBestsellers();
    const candidateIds = bestsellers.supplierCandidateIds
      .slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE)
      .filter(Boolean);

    // 2. Investigate suppliers only for physical products matching the
    // women's product strategy. Keep all candidates for the Sales Test Gate
    // so non-matching rows are explicitly rejected there rather than silently
    // disappearing from the audit trail.
    const supabase = createSupabaseAdminClient();
    const { data: candidateRows, error: candidateReadError } = candidateIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("marketplace_bestsellers")
          .select("id,title,category")
          .in("id", candidateIds);
    if (candidateReadError) throw new Error(candidateReadError.message);

    const supplierCandidateFilter = filterSupplierCandidateIds(
      candidateIds,
      (candidateRows ?? []).map((row) => ({
        id: row.id,
        title: row.title,
        category: row.category,
      })),
    );
    const { supplierCandidateIds } = supplierCandidateFilter;

    // 3. Resolve supplier evidence only for relevant, physical candidates.
    const suppliers = await investigateDropshipForBestsellers(supplierCandidateIds);

    // 4. Build canonical opportunity intelligence from persisted demand/supply
    // evidence. No manual opportunity row is created here.
    const opportunity = await buildOpportunityIntelligence();

    // 5. The only publication path is the canonical Sales Test Gate. It still
    // sees all observed candidates and records why excluded items were blocked.
    const selected = await selectAndPublishSalesTests(candidateIds, 5);

    // 6. NEWFIND receives only listings that actually passed the Sales Test Gate.
    const shopify = await syncPublishedListingsToShopify(selected.selectedListingIds);
    const newfind = await Promise.all(
      shopify.listingIds.map((listingId) =>
        promoteShopListingToNewfind(listingId).catch((error) => ({
          configured: true,
          sent: false,
          eventId: `tracer-shop-listing:${listingId}`,
          status: null,
          detail: error instanceof Error ? error.message : String(error),
        })),
      ),
    );

    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      mode: "canonical_demand_opportunity_sales_test",
      supplierCandidateFilter,
      bestsellers,
      suppliers,
      opportunity,
      selected,
      shopify,
      newfind,
      salesReady: shopify.listingIds.length > 0,
    });
  } catch (error) {
    console.error("[TRACER BESTSELLERS ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
