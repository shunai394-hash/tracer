import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { recalculatePrice } from "@/lib/commerce/core";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Reprice already-linked supplier offers without calling the supplier API.
 * New-product discovery is deliberately not part of this job. Missing/zero-profit
 * variants are handled first; live stock and orderability remain procurement checks.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 100);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 100;

  const [{ data: offers, error: offersError }, { data: activeProducts, error: productsError }, { data: prices, error: pricesError }] = await Promise.all([
    db.from("supplier_offers")
      .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,currency,unit_cost,shipping_cost,updated_at")
      .order("updated_at", { ascending: true })
      .limit(2000),
    db.from("commerce_products").select("id").eq("active", true).limit(2000),
    db.from("commerce_prices").select("variant_id,supplier_offer_id,expected_profit,calculated_at").limit(4000),
  ]);
  if (offersError || productsError || pricesError) {
    return NextResponse.json({
      ok: false,
      error: "existing_offer_reprice_read_failed",
      details: [offersError?.message, productsError?.message, pricesError?.message].filter(Boolean),
    }, { status: 500 });
  }

  const activeProductIds = new Set((activeProducts ?? []).map((row) => String(row.id)));
  const { data: variants, error: variantsError } = await db.from("commerce_variants")
    .select("id,product_id")
    .in("product_id", [...activeProductIds].slice(0, 2000))
    .limit(4000);
  if (variantsError) {
    return NextResponse.json({ ok: false, error: "existing_variant_read_failed", detail: variantsError.message }, { status: 500 });
  }
  const activeVariantIds = new Set((variants ?? []).map((row) => String(row.id)));
  const priceByOffer = new Map((prices ?? []).map((row) => [String(row.supplier_offer_id), row]));
  const candidates = (offers ?? [])
    .filter((offer) => activeVariantIds.has(String(offer.variant_id)))
    .filter((offer) => Number.isFinite(Number(offer.unit_cost)) && Number(offer.unit_cost) >= 0)
    .filter((offer) => Number.isFinite(Number(offer.shipping_cost)) && Number(offer.shipping_cost) >= 0)
    .filter((offer) => ["USD", "JPY"].includes(String(offer.currency ?? "").toUpperCase()))
    .sort((a, b) => {
      const ap = priceByOffer.get(String(a.id));
      const bp = priceByOffer.get(String(b.id));
      const aNeedsPrice = !ap || Number(ap.expected_profit) <= 0;
      const bNeedsPrice = !bp || Number(bp.expected_profit) <= 0;
      if (aNeedsPrice !== bNeedsPrice) return aNeedsPrice ? -1 : 1;
      return String(ap?.calculated_at ?? a.updated_at ?? "").localeCompare(String(bp?.calculated_at ?? b.updated_at ?? ""));
    })
    .slice(0, limit);

  const usdJpy = await getObservedUsdToJpyRate();
  if (!usdJpy || !Number.isFinite(usdJpy.rate) || usdJpy.rate <= 0) {
    return NextResponse.json({ ok: false, error: "usd_jpy_rate_unavailable", considered: candidates.length, repriced: 0 }, { status: 503 });
  }

  const result = { considered: candidates.length, repriced: 0, skipped: 0, errors: [] as Array<{ offerId: string; reason: string }> };
  for (const offer of candidates) {
    try {
      await recalculatePrice({
        variantId: String(offer.variant_id),
        offerId: String(offer.id),
        exchangeRateToJpy: String(offer.currency).toUpperCase() === "JPY" ? 1 : usdJpy.rate,
        feeRate: 0.1,
        targetMarginRate: 0.2,
      });
      result.repriced++;
    } catch (error) {
      result.skipped++;
      result.errors.push({
        offerId: String(offer.id),
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 180),
      });
    }
  }

  return NextResponse.json({ ok: true, ...result, sourceApiCalls: 0, fxRate: usdJpy.rate });
}
