import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { selectAndPublishSupplySalesTests } from "@/lib/market/select-supply-sales-tests";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only trace of products through product -> product_intelligence ->
 * opportunity_intelligence -> Sales Test Gate (dry run, no writes) ->
 * sales_tests -> shop_listings -> NEWFIND delivery. ?ids=uuid,uuid (max 20).
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const ids = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",").map((id) => id.trim()).filter((id) => UUID.test(id)).slice(0, 20);
  if (ids.length === 0) return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });

  const db = createSupabaseAdminClient();
  const [products, pi, offers, listings, shop, oi, deliveries, matches, piCount] = await Promise.all([
    db.from("products").select("id, canonical_name, identity_key, created_at").in("id", ids),
    db.from("product_intelligence").select("product_id, normalized_title, image_url, currency, current_price, identity_confidence, metadata, updated_at").in("product_id", ids),
    db.from("product_offers").select("id, product_id, seller_name, price, currency, shipping_price, availability, observed_at").in("product_id", ids),
    db.from("supplier_listings").select("id, product_id, supplier, supplier_product_id, supplier_variant_id, identity_method, identity_status, identity_confidence, verification_status, inventory_confirmed, orderable, inventory, cost, currency, shipping_cost, tracking_available, api_available, price_confirmed, fetched_at, next_verification_at, verification_error, verification_attempts, last_verified_at, shipping_status").in("product_id", ids),
    db.from("shop_listings").select("id, product_id, slug, supplier_name, supplier_product_id, supplier_variant_id, supplier_listing_id, published, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, base_item_id, base_publication_status, selling_price, inventory, orderable, tracking_available, updated_at").in("product_id", ids),
    db.from("opportunity_intelligence").select("id, product_id, sellability_state, lifecycle_status, demand_score, selection_eligible, selection_score, overall_confidence, filter_state, profit_state, profit_calculable, latest_test_status, market_price, source_cost, contribution_margin, metadata, updated_at").in("product_id", ids),
    db.from("newfind_promotion_deliveries").select("listing_id, event_id, status, ack_status, last_error, updated_at"),
    db.from("demand_product_matches").select("product_id, match_method, rationale").in("product_id", ids),
    db.from("product_intelligence").select("product_id", { count: "exact", head: true }),
  ]);
  const readErrors = [products, pi, offers, listings, shop, oi, deliveries, matches, piCount]
    .map((r) => r.error?.message).filter(Boolean);

  const oiIds = (oi.data ?? []).map((row) => String(row.id));
  const tests = oiIds.length > 0
    ? await db.from("sales_tests").select("id, opportunity_id, status, started_at, completed_at").in("opportunity_id", oiIds)
    : { data: [], error: null };

  // Position of each product in the product_id-ordered sweep, to show
  // whether the page-by-page Opportunity Intelligence sweep can reach it.
  const sweepRank: Record<string, number | string> = {};
  for (const id of ids) {
    const { count, error } = await db.from("product_intelligence").select("product_id", { count: "exact", head: true }).lt("product_id", id);
    sweepRank[id] = error ? `error: ${error.message}` : count ?? 0;
  }

  const gate = await selectAndPublishSupplySalesTests(ids, 0 + ids.length, { dryRun: true });

  const listingIds = new Set((shop.data ?? []).map((row) => String(row.id)));
  const by = <T extends Record<string, unknown>>(rows: T[] | null, id: string) => (rows ?? []).filter((row) => String(row.product_id) === id);

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    deployment: { commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
    readErrors,
    productIntelligenceRows: piCount.count ?? null,
    products: ids.map((id) => {
      const shopRows = by(shop.data as Record<string, unknown>[] | null, id);
      return {
        product_id: id,
        product: (products.data ?? []).find((row) => String(row.id) === id) ?? null,
        product_intelligence: by(pi.data as Record<string, unknown>[] | null, id)[0] ?? null,
        sweep_rank: sweepRank[id],
        offers: by(offers.data as Record<string, unknown>[] | null, id),
        supplier_listings: by(listings.data as Record<string, unknown>[] | null, id),
        demand_matches: by(matches.data as Record<string, unknown>[] | null, id).length,
        opportunity_intelligence: by(oi.data as Record<string, unknown>[] | null, id)[0] ?? null,
        sales_tests: (tests.data ?? []).filter((row) => oiIds.length > 0 && by(oi.data as Record<string, unknown>[] | null, id).some((o) => String(o.id) === String(row.opportunity_id))),
        shop_listings: shopRows.map((row) => ({ ...row, sales_test_gate_passed: hasPassedSalesTestGate(row) })),
        newfind: (deliveries.data ?? []).filter((row) => listingIds.has(String(row.listing_id)) && shopRows.some((s) => String(s.id) === String(row.listing_id))),
        gate_dry_run: gate.eligibleProductIds?.includes(id)
          ? { result: "would_pass" }
          : { result: "rejected", reasons: gate.rejected.find((r) => r.productId === id)?.reasons ?? [] },
      };
    }),
  });
}
