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
    db.from("commerce_prices").select("variant_id,supplier_offer_id,selling_price,expected_profit,margin_rate,calculated_at")
      .order("calculated_at", { ascending: false, nullsFirst: false })
      .limit(4000),
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
  // The query is newest-first. Keep the first row per variant so a later/older
  // historical price cannot overwrite the canonical current price in either map.
  const priceByVariant = new Map<string, NonNullable<typeof prices>[number]>();
  const canonicalPriceByVariant = new Map<string, number>();
  for (const row of prices ?? []) {
    const variantId = String(row.variant_id);
    if (priceByVariant.has(variantId)) continue;
    priceByVariant.set(variantId, row);
    canonicalPriceByVariant.set(variantId, Number(row.selling_price));
  }
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
      canonicalPriceByVariant.set(variantId, price.sellingPrice);
    } catch (error) {
      result.skipped++;
      result.errors.push({
        offerId: String(offer.id),
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 180),
      });
    }
  }

  const unverifiedVariantIds = new Set([...oneOfferPerVariant.values()].filter((offer) => {
    const rawData = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
      ? offer.raw_data as Record<string, unknown>
      : {};
    const shippingKnown = (Number.isFinite(Number(offer.shipping_cost)) && Number(offer.shipping_cost) > 0) ||
      rawData.shippingKnown === true;
    const stockKnown = rawData.stockKnown === true ||
      (rawData.stockKnown === undefined && offer.source_status === "verified");
    return offer.source_status !== "verified" || !shippingKnown || !stockKnown;
  }).map((offer) => String(offer.variant_id)));

  // Reconcile storefront prices already published before the canonical price change.
  // Process up to twenty actually stale variants per channel; the cron is staggered from publication and order-poll jobs.
  // Query all states so a failed sync remains eligible for retry on the next cron run.
  const { data: listings, error: listingReadError } = await db.from("channel_listings")
    .select("variant_id,channel,selling_price,status,last_synced_at")
    // Rotate through oldest sync timestamps so an unchanged first batch cannot starve later stale rows.
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(5000);
  if (listingReadError) {
    result.storefrontSyncErrors.push({ channel: "lookup", reason: listingReadError.message.slice(0, 180) });
  } else {
    // Select only rows that are still stale. Including every repriced variant here
    // re-synced already-correct listings and starved the real backlog on each cron run.
    for (const channel of ["base", "shopify"] as const) {
      const allChannelIds = [...new Set((listings ?? [])
        .filter((row) => {
          if (row.channel !== channel) return false;
          const variantId = String(row.variant_id);
          const canonicalPrice = canonicalPriceByVariant.get(variantId);
          if (canonicalPrice === undefined) return false;
          if (row.status === "published" && unverifiedVariantIds.has(variantId)) return true;
          if (unverifiedVariantIds.has(variantId)) return false;
          return Number(row.selling_price) !== canonicalPrice || row.status !== "published";
        })
        .map((row) => String(row.variant_id)))];
      // Keep each channel update small enough to leave headroom under the 300s function timeout.
      // Ten variants per channel is bounded and retries rotate through the oldest stale listings.
      const batchIds = allChannelIds.slice(0, 10);
      if (batchIds.length === 0) continue;
      try {
        const synced = await syncCommerceListings(channel, batchIds.length, false, batchIds);
        const processed = Number(synced.processed ?? synced.published);
        result.storefrontSync[channel] += processed;
        result.storefrontSyncRemaining[channel] = Math.max(0, allChannelIds.length - processed);
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
