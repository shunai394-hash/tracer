import { NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { persistMarketplaceBestsellers } from "@/lib/market/persist-bestsellers";
import { investigateDropshipForBestsellers } from "@/lib/suppliers/investigate-dropship";
import { selectAndPublishSalesTests } from "@/lib/market/select-sales-tests";
import { discoverAndCreateCjSupply } from "@/lib/suppliers/discover-cj-supply";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const startedAt = Date.now();

    // Supply-first is now the primary path: a real CJ product with live
    // variant/stock/freight evidence can become a TRACER-owned listing without
    // pretending that it is identical to a marketplace product.
    const supplyFirst = await discoverAndCreateCjSupply(50);

    // Supply-first only verifies supplier-side availability.
    // Public publication remains behind the intelligence + sales-test gate.

    // Continue with the market-linked pipeline.
    const bestsellers = await persistMarketplaceBestsellers();
    const candidateIds = bestsellers.supplierCandidateIds.slice(0, BESTSELLER_CANDIDATE_BATCH_SIZE);
    const suppliers = await investigateDropshipForBestsellers(candidateIds);
    const selected = await selectAndPublishSalesTests(candidateIds, 5);

    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - startedAt,
      mode: "market_linked_sales_test",
      supplyFirst,
      bestsellers,
      suppliers,
      selected,
      salesReady: selected.published > 0,
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
