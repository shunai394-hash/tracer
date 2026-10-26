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
      .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,currency,unit_cost,shipping_cost,inventory,ship_to,tracking_supported,source_status,last_checked_at,raw_data,updated_at")
      // Prefer recently refreshed offers so the bounded scan does not permanently miss new verified inventory.
      .order("updated_at", { ascending: false })
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
    .select("id,product_id,commerce_products!inner(updated_at)")
    .in("product_id", [...activeProductIds].slice(0, 2000))
    .limit(4000);
  if (variantsError) {
    return NextResponse.json({ ok: false, error: "existing_variant_read_failed", detail: variantsError.message }, { status: 500 });
  }
  const activeVariantIds = new Set((variants ?? []).map((row) => String(row.id)));
  const productUpdatedAtByVariant = new Map<string, string>();
  for (const row of variants ?? []) {
    const relatedProduct = Array.isArray(row.commerce_products) ? row.commerce_products[0] : row.commerce_products;
    if (typeof relatedProduct?.updated_at === "string") productUpdatedAtByVariant.set(String(row.id), relatedProduct.updated_at);
  }
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
    const shippingKnown = rawData.shippingEstimated !== true && (
      rawData.shippingKnown === true ||
      (rawData.shippingKnown === undefined && offer.source_status === "verified" && Number(offer.shipping_cost) > 0)
    );
    if (!shippingKnown) {
      skippedUnknownShipping++;
      continue;
    }
    if (!Number.isFinite(Number(offer.unit_cost)) || Number(offer.unit_cost) < 0) continue;
    if (!Number.isFinite(Number(offer.shipping_cost)) || Number(offer.shipping_cost) < 0) continue;
    if (!["USD", "JPY"].includes(String(offer.currency ?? "").toUpperCase())) continue;
    const currentPrice = priceByVariant.get(variantId);
    const existing = oneOfferPerVariant.get(variantId);
    const isFulfillable = (candidate: typeof offer) => {
      const candidateRaw = candidate.raw_data && typeof candidate.raw_data === "object" && !Array.isArray(candidate.raw_data)
        ? candidate.raw_data as Record<string, unknown>
        : {};
      const checkedAt = typeof candidate.last_checked_at === "string" ? Date.parse(candidate.last_checked_at) : Number.NaN;
      const fresh = Number.isFinite(checkedAt) && checkedAt <= Date.now() + 5 * 60_000 &&
        Date.now() - checkedAt <= 24 * 60 * 60_000;
      const stockKnown = candidateRaw.stockKnown === true ||
        (candidateRaw.stockKnown === undefined && candidate.source_status === "verified");
      const shippingKnown = candidateRaw.shippingEstimated !== true && (
        candidateRaw.shippingKnown === true ||
        (candidateRaw.shippingKnown === undefined && candidate.source_status === "verified" && Number(candidate.shipping_cost) > 0)
      );
      return candidate.source_status === "verified" && fresh && stockKnown && shippingKnown &&
        candidate.ship_to === "JP" && candidate.tracking_supported === true &&
        Number.isFinite(Number(candidate.inventory)) && Number(candidate.inventory) > 0;
    };
    const offerIsCurrent = currentPrice && String(currentPrice.supplier_offer_id) === String(offer.id);
    const existingIsCurrent = existing && currentPrice && String(currentPrice.supplier_offer_id) === String(existing.id);
    const offerReady = isFulfillable(offer);
    const existingReady = existing ? isFulfillable(existing) : false;
    // Prefer a fresh, verified, Japan-shippable offer over a stale offer pinned by
    // the current price. Keep the current offer only when readiness is equivalent.
    if (!existing ||
      (offerReady && !existingReady) ||
      (offerReady === existingReady && offerIsCurrent && !existingIsCurrent) ||
      (offerReady === existingReady && !offerIsCurrent && !existingIsCurrent &&
        String(offer.updated_at ?? "") > String(existing.updated_at ?? ""))) {
      oneOfferPerVariant.set(variantId, offer);
    }
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
    storefrontSyncFailureDetails: [] as Array<{ channel: string; variantId: string; reason: string }>,
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

  const offersById = new Map((offers ?? []).map((offer) => [String(offer.id), offer]));
  const unverifiedVariantIds = new Set([...priceByVariant.entries()].filter(([, price]) => {
    const offer = offersById.get(String(price.supplier_offer_id));
    if (!offer) return true;
    const rawData = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
      ? offer.raw_data as Record<string, unknown>
      : {};
    const shippingKnown = rawData.shippingEstimated !== true && (
      rawData.shippingKnown === true ||
      (rawData.shippingKnown === undefined && offer.source_status === "verified" && Number(offer.shipping_cost) > 0)
    );
    const stockKnown = rawData.stockKnown === true ||
      (rawData.stockKnown === undefined && offer.source_status === "verified");
    return offer.source_status !== "verified" || !shippingKnown || !stockKnown;
  }).map(([variantId]) => variantId));

  // Reconcile storefront prices already published before the canonical price change.
  // Process up to twenty-five stale variants per channel while keeping each run bounded.
  // Query all states so a failed sync remains eligible for retry on the next cron run.
  const { data: listings, error: listingReadError } = await db.from("channel_listings")
    .select("variant_id,channel,selling_price,status,last_synced_at,last_error")
    // Rotate through oldest sync timestamps so an unchanged first batch cannot starve later stale rows.
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(5000);
  if (listingReadError) {
    result.storefrontSyncErrors.push({ channel: "lookup", reason: listingReadError.message.slice(0, 180) });
  } else {
    // Published listings without any supplier offer must enter this queue too.
    // Otherwise no offer means no canonical price, so the old eligibility filter
    // skipped them forever and the global 5-item safety cleanup never got triggered.
    const publishedVariantIds = [...new Set((listings ?? [])
      .filter((row) => row.status === "published")
      .map((row) => String(row.variant_id))
      .filter(Boolean))];
    const supplierOfferVariantIds = new Set<string>();
    let supplierOfferLookupFailed = false;
    for (let offset = 0; offset < publishedVariantIds.length; offset += 100) {
      const ids = publishedVariantIds.slice(offset, offset + 100);
      const { data: offerVariants, error: offerVariantsError } = await db.from("supplier_offers")
        .select("variant_id")
        .in("variant_id", ids)
        .limit(1000);
      if (offerVariantsError) {
        supplierOfferLookupFailed = true;
        result.storefrontSyncErrors.push({
          channel: "lookup",
          reason: ("published_supplier_offer_lookup_failed:" + offerVariantsError.message).slice(0, 180),
        });
        break;
      }
      for (const offer of offerVariants ?? []) supplierOfferVariantIds.add(String(offer.variant_id));
    }
    // Fail closed on lookup errors: do not infer a missing offer from an incomplete read.
    const publishedMissingOfferVariantIds = new Set(
      supplierOfferLookupFailed ? [] : publishedVariantIds.filter((id) => !supplierOfferVariantIds.has(id)),
    );
    // Select only rows that are still stale. Including every repriced variant here
    // re-synced already-correct listings and starved the real backlog on each cron run.
    for (const channel of ["base", "shopify"] as const) {
      const recentCopyCutoff = Date.now() - 24 * 60 * 60_000;
      const eligibleRows = (listings ?? []).filter((row) => {
        if (row.channel !== channel) return false;
        const variantId = String(row.variant_id);
        // Only active product variants can be processed by syncCommerceListings.
        // Exclude inactive/missing variants from the backlog calculation too, or
        // they remain permanently eligible and make every reprice run report an
        // undrainable queue even when all actionable listings have been synced.
        if (!activeVariantIds.has(variantId)) return false;
        const canonicalPrice = canonicalPriceByVariant.get(variantId);
        const productUpdatedAt = productUpdatedAtByVariant.get(variantId);
        const contentNeedsSync = Boolean(productUpdatedAt) &&
          (!row.last_synced_at || Date.parse(productUpdatedAt!) > Date.parse(String(row.last_synced_at)));
        // Disable unverified supplier listings once, then stop re-queueing the safety state.
        if (row.status === "published" && publishedMissingOfferVariantIds.has(variantId)) return true;
        if (canonicalPrice !== undefined && unverifiedVariantIds.has(variantId)) {
          return row.status === "published" &&
            !String(row.last_error ?? "").startsWith("supplier_offer_not_fulfillable:");
        }
        return canonicalPrice !== undefined &&
          (Number(row.selling_price) !== canonicalPrice || row.status !== "published" || contentNeedsSync);
      });
      const priority = (row: (typeof eligibleRows)[number]) => {
        const variantId = String(row.variant_id);
        if (row.status === "published" && unverifiedVariantIds.has(variantId)) return 0;
        if (row.status === "published" && publishedMissingOfferVariantIds.has(variantId)) return 0;
        const productUpdatedAt = productUpdatedAtByVariant.get(variantId);
        const contentNeedsSync = Boolean(productUpdatedAt) &&
          (!row.last_synced_at || Date.parse(productUpdatedAt!) > Date.parse(String(row.last_synced_at)));
        if (contentNeedsSync && productUpdatedAt && Date.parse(productUpdatedAt) >= recentCopyCutoff) return 1;
        if (row.status !== "published") return 2;
        if (Number(row.selling_price) !== canonicalPriceByVariant.get(variantId)) return 3;
        return 4;
      };
      const allChannelIds = [...new Set(eligibleRows
        .sort((a, b) => {
          const priorityDiff = priority(a) - priority(b);
          if (priorityDiff !== 0) return priorityDiff;
          if (priority(a) === 1) {
            const aUpdated = Date.parse(String(productUpdatedAtByVariant.get(String(a.variant_id)) ?? ""));
            const bUpdated = Date.parse(String(productUpdatedAtByVariant.get(String(b.variant_id)) ?? ""));
            if (aUpdated !== bUpdated) return bUpdated - aUpdated;
          }
          const aTime = a.last_synced_at ? Date.parse(String(a.last_synced_at)) : 0;
          const bTime = b.last_synced_at ? Date.parse(String(b.last_synced_at)) : 0;
          return aTime - bTime;
        })
        .map((row) => String(row.variant_id)))];
      // Keep each channel update small enough to leave headroom under the 300s function timeout.
      // Twenty-five variants per channel is bounded; safety and fresh copy outrank stale-price backlog.
      const batchIds = allChannelIds.slice(0, 25);
      if (batchIds.length === 0) continue;
      try {
        const synced = await syncCommerceListings(channel, batchIds.length, false, batchIds);
        const processed = Number(synced.processed ?? synced.published);
        result.storefrontSync[channel] += processed;
        result.storefrontSyncRemaining[channel] = Math.max(0, allChannelIds.length - processed);
        for (const failure of (synced.results ?? []).filter((item) => !item.ok).slice(0, 10)) {
          result.storefrontSyncFailureDetails.push({
            channel,
            variantId: String(failure.variantId),
            reason: String(failure.error ?? "storefront_sync_failed").slice(0, 180),
          });
        }
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
  // A drained queue is part of success: a healthy batch with a remaining backlog is partial, not complete.
  const ok = result.skipped === 0 && result.errors.length === 0 && result.storefrontSyncErrors.length === 0 && storefrontSyncComplete;
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
    storefrontSyncErrors: result.storefrontSyncErrors.map(({ channel, reason }) => ({ channel, reason })),
    storefrontSyncFailureDetails: result.storefrontSyncFailureDetails.slice(0, 20),
    repriceErrorCount: result.errors.length,
    repriceErrors: result.errors.slice(0, 5).map(({ offerId, reason }) => ({ offerId, reason })),
  });
  return NextResponse.json({ ok, storefrontSyncComplete, ...result, sourceApiCalls: 0, fxRate: usdJpy.rate }, { status: ok ? 200 : 207 });
}
