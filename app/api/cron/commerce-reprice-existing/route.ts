import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { recalculatePrice } from "@/lib/commerce/core";
import { syncCommerceListings } from "@/lib/commerce/publish";

export const runtime = "nodejs";
export const maxDuration = 300;

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
  // Never accept the old 20% default: require at least 50% net margin after supplier landed cost and platform fees.
  const targetMarginRate = 0.5;

  const [{ data: offers, error: offersError }, { data: activeProducts, error: productsError }, { data: prices, error: pricesError }] = await Promise.all([
    db.from("supplier_offers")
      .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,currency,unit_cost,shipping_cost,source_status,raw_data,updated_at")
      .order("updated_at", { ascending: true })
      .limit(2000),
    db.from("commerce_products").select("id").eq("active", true).limit(2000),
    db.from("commerce_prices").select("variant_id,supplier_offer_id,selling_price,expected_profit,margin_rate,calculated_at").limit(4000),
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
  const priceByVariant = new Map((prices ?? []).map((row) => [String(row.variant_id), row]));
  const canonicalPriceByVariant = new Map((prices ?? []).map((row) => [String(row.variant_id), Number(row.selling_price)]));
  let skippedUnknownShipping = 0;
  const oneOfferPerVariant = new Map<string, NonNullable<typeof offers>[number]>();
  for (const offer of offers ?? []) {
    const variantId = String(offer.variant_id);
    if (!activeVariantIds.has(variantId) || offer.unit_cost === null || offer.shipping_cost === null) continue;
    const rawData = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
      ? offer.raw_data as Record<string, unknown>
      : {};
    const shippingKnown = rawData.shippingKnown === true ||
      (rawData.shippingKnown === undefined && offer.source_status === "verified" && Number(offer.shipping_cost) > 0);
    if (!shippingKnown) {
      skippedUnknownShipping++;
      continue;
    }
    if (!Number.isFinite(Number(offer.unit_cost)) || Number(offer.unit_cost) < 0) continue;
    if (!Number.isFinite(Number(offer.shipping_cost)) || Number(offer.shipping_cost) < 0) continue;
    if (!["USD", "JPY"].includes(String(offer.currency ?? "").toUpperCase())) continue;
    const currentPrice = priceByVariant.get(variantId);
    const existing = oneOfferPerVariant.get(variantId);
    const offerIsCurrent = currentPrice && String(currentPrice.supplier_offer_id) === String(offer.id);
    const existingIsCurrent = existing && currentPrice && String(currentPrice.supplier_offer_id) === String(existing.id);
    if (!existing || (offerIsCurrent && !existingIsCurrent)) oneOfferPerVariant.set(variantId, offer);
  }
  const candidates = [...oneOfferPerVariant.values()]
    .filter((offer) => {
      const price = priceByVariant.get(String(offer.variant_id));
      return !price || Number(price.expected_profit) <= 0 || Number(price.margin_rate) < targetMarginRate || String(price.supplier_offer_id) !== String(offer.id) ||
        String(price.calculated_at ?? "") < String(offer.updated_at ?? "");
    })
    .sort((a, b) => {
      const ap = priceByVariant.get(String(a.variant_id));
      const bp = priceByVariant.get(String(b.variant_id));
      const aNeedsPrice = !ap || Number(ap.expected_profit) <= 0 || Number(ap.margin_rate) < targetMarginRate || String(ap.supplier_offer_id) !== String(a.id);
      const bNeedsPrice = !bp || Number(bp.expected_profit) <= 0 || Number(bp.margin_rate) < targetMarginRate || String(bp.supplier_offer_id) !== String(b.id);
      if (aNeedsPrice !== bNeedsPrice) return aNeedsPrice ? -1 : 1;
      return String(ap?.calculated_at ?? a.updated_at ?? "").localeCompare(String(bp?.calculated_at ?? b.updated_at ?? ""));
    })
    .slice(0, limit);

  const usdJpy = await getObservedUsdToJpyRate();
  if (!usdJpy || !Number.isFinite(usdJpy.rate) || usdJpy.rate <= 0) {
    return NextResponse.json({ ok: false, error: "usd_jpy_rate_unavailable", considered: candidates.length, repriced: 0 }, { status: 503 });
  }

  const result = {
    considered: candidates.length,
    repriced: 0,
    skipped: 0,
    skippedUnknownShipping,
    errors: [] as Array<{ offerId: string; reason: string }>,
    storefrontSync: { base: 0, shopify: 0 },
    storefrontSyncRemaining: { base: 0, shopify: 0 },
    storefrontSyncErrors: [] as Array<{ channel: string; reason: string }>,
  };
  const repricedVariantIds: string[] = [];
  for (const offer of candidates) {
    try {
      const price = await recalculatePrice({
        variantId: String(offer.variant_id),
        offerId: String(offer.id),
        exchangeRateToJpy: String(offer.currency).toUpperCase() === "JPY" ? 1 : usdJpy.rate,
        feeRate: 0.1,
        targetMarginRate,
      });
      result.repriced++;
      const variantId = String(offer.variant_id);
      const previous = priceByVariant.get(variantId);
      canonicalPriceByVariant.set(variantId, price.sellingPrice);
      if (!previous || Number(previous.selling_price) !== price.sellingPrice) repricedVariantIds.push(variantId);
    } catch (error) {
      result.skipped++;
      result.errors.push({
        offerId: String(offer.id),
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 180),
      });
    }
  }

  // Reconcile storefront prices already published before the canonical price change.
  // Query all states so a failed sync remains eligible for retry on the next cron run.
  const { data: listings, error: listingReadError } = await db.from("channel_listings")
    .select("variant_id,channel,selling_price,status")
    .limit(5000);
  if (listingReadError) {
    result.storefrontSyncErrors.push({ channel: "lookup", reason: listingReadError.message.slice(0, 180) });
  } else {
    const needsSync = new Set(repricedVariantIds);
    for (const listing of listings ?? []) {
      const variantId = String(listing.variant_id);
      const canonicalPrice = canonicalPriceByVariant.get(variantId);
      if (canonicalPrice !== undefined &&
          (Number(listing.selling_price) !== canonicalPrice || listing.status !== "published")) {
        needsSync.add(variantId);
      }
    }
    for (const channel of ["base", "shopify"] as const) {
      const allChannelIds = [...new Set((listings ?? [])
        .filter((row) => row.channel === channel && needsSync.has(String(row.variant_id)))
        .map((row) => String(row.variant_id)))];
      const batchIds = allChannelIds.slice(0, 10);
      if (batchIds.length === 0) continue;
      try {
        const synced = await syncCommerceListings(channel, batchIds.length, false, batchIds);
        result.storefrontSync[channel] += synced.published;
        result.storefrontSyncRemaining[channel] = Math.max(0, allChannelIds.length - synced.published);
        if (synced.failed > 0 || synced.considered < batchIds.length) {
          result.storefrontSyncErrors.push({
            channel,
            reason: `requested=${batchIds.length}, considered=${synced.considered}, updated=${synced.published}, failed=${synced.failed}, backlog=${allChannelIds.length}`,
          });
        }
      } catch (error) {
        result.storefrontSyncErrors.push({
          channel,
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 180),
        });
      }
    }
  }
  const storefrontSyncComplete = result.storefrontSyncRemaining.base === 0 && result.storefrontSyncRemaining.shopify === 0;
  const ok = result.skipped === 0 && result.errors.length === 0 && result.storefrontSyncErrors.length === 0;
  console.info("[TRACER STOREFRONT PRICE RECONCILE]", {
    generatedAt: new Date().toISOString(),
    ok,
    storefrontSyncComplete,
    considered: result.considered,
    repriced: result.repriced,
    skipped: result.skipped,
    skippedUnknownShipping: result.skippedUnknownShipping,
    storefrontSync: result.storefrontSync,
    storefrontSyncRemaining: result.storefrontSyncRemaining,
    storefrontSyncErrorCount: result.storefrontSyncErrors.length,
  });
  return NextResponse.json({ ok, storefrontSyncComplete, ...result, sourceApiCalls: 0, fxRate: usdJpy.rate }, { status: ok ? 200 : 207 });
}
