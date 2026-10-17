import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { editBaseItem, getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";
import { toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Reconcile already-published legacy shop_listings to the canonical commerce_prices.
 * This edits the exact existing BASE item only; it never creates a second item.
 * Exact supplier variant + current verified offer + current positive-profit price are required.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 15);
  const limit = Number.isFinite(requestedLimit) ? Math.min(25, Math.max(1, Math.floor(requestedLimit))) : 15;
  const db = createSupabaseAdminClient();

  const [
    { data: listings, error: listingError },
    { data: variants, error: variantError },
    { data: offers, error: offerError },
    { data: prices, error: priceError },
  ] = await Promise.all([
    db.from("shop_listings")
      .select("id,title,description,base_item_id,selling_price,contribution_profit,inventory,published,orderable,tracking_available,supplier_variant_id")
      .eq("published", true)
      .eq("orderable", true)
      .eq("tracking_available", true)
      .not("base_item_id", "is", null)
      .not("supplier_variant_id", "is", null)
      .order("updated_at", { ascending: true })
      .limit(2000),
    db.from("commerce_variants").select("id,source_variant_key").limit(5000),
    db.from("supplier_offers")
      .select("id,variant_id,supplier_variant_id,source_status,unit_cost,shipping_cost,inventory,raw_data,updated_at")
      .order("updated_at", { ascending: false })
      .limit(5000),
    db.from("commerce_prices")
      .select("variant_id,supplier_offer_id,selling_price,expected_profit,margin_rate,calculated_at")
      .order("calculated_at", { ascending: false, nullsFirst: false })
      .limit(10000),
  ]);

  const readErrors = [listingError, variantError, offerError, priceError].filter(Boolean);
  if (readErrors.length) {
    return NextResponse.json({
      ok: false,
      error: "legacy_base_price_reconcile_read_failed",
      details: readErrors.map((item) => item?.message),
    }, { status: 500 });
  }

  const variantIdBySupplierKey = new Map<string, string>();
  const duplicateSupplierKeys = new Set<string>();
  for (const variant of variants ?? []) {
    const key = String(variant.source_variant_key ?? "").trim();
    if (!key) continue;
    if (variantIdBySupplierKey.has(key)) duplicateSupplierKeys.add(key);
    else variantIdBySupplierKey.set(key, String(variant.id));
  }
  for (const key of duplicateSupplierKeys) variantIdBySupplierKey.delete(key);

  const offerByVariantId = new Map<string, NonNullable<typeof offers>[number]>();
  for (const offer of offers ?? []) {
    const variantId = String(offer.variant_id);
    if (!offerByVariantId.has(variantId)) offerByVariantId.set(variantId, offer);
  }

  const priceByVariantId = new Map<string, NonNullable<typeof prices>[number]>();
  for (const price of prices ?? []) {
    const variantId = String(price.variant_id);
    if (!priceByVariantId.has(variantId)) priceByVariantId.set(variantId, price);
  }

  const counts = {
    scanned: (listings ?? []).length,
    eligible: 0,
    updated: 0,
    alreadyCurrent: 0,
    skippedIdentity: 0,
    skippedOfferEvidence: 0,
    skippedPrice: 0,
    failed: 0,
    remainingMismatches: 0,
  };
  const results: Array<{ listingId: string; baseItemId: string; ok: boolean; oldPrice?: number; canonicalPrice?: number; reason?: string }> = [];

  const candidates = (listings ?? []).flatMap((listing) => {
    const supplierKey = String(listing.supplier_variant_id ?? "").trim();
    const variantId = variantIdBySupplierKey.get(supplierKey);
    if (!variantId || duplicateSupplierKeys.has(supplierKey)) {
      counts.skippedIdentity++;
      return [];
    }
    const offer = offerByVariantId.get(variantId);
    if (!offer || String(offer.supplier_variant_id ?? "") !== supplierKey) {
      counts.skippedIdentity++;
      return [];
    }
    const raw = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
      ? offer.raw_data as Record<string, unknown>
      : {};
    const stockKnown = raw.stockKnown === true;
    const shippingKnown = raw.shippingKnown === true || raw.shippingEstimated === true;
    const inventory = Number(offer.inventory);
    const unitCost = Number(offer.unit_cost);
    const shippingCost = Number(offer.shipping_cost);
    if (offer.source_status !== "verified" || !stockKnown || !shippingKnown ||
        !Number.isFinite(inventory) || inventory <= 0 ||
        !Number.isFinite(unitCost) || unitCost < 0 ||
        !Number.isFinite(shippingCost) || shippingCost < 0) {
      counts.skippedOfferEvidence++;
      return [];
    }
    const price = priceByVariantId.get(variantId);
    const canonicalPrice = Number(price?.selling_price);
    const profit = Number(price?.expected_profit);
    if (!price || String(price.supplier_offer_id ?? "") !== String(offer.id) ||
        !Number.isFinite(canonicalPrice) || canonicalPrice <= 0 ||
        !Number.isFinite(profit) || profit <= 0) {
      counts.skippedPrice++;
      return [];
    }
    return [{ listing, offer, price, canonicalPrice, inventory }];
  }).sort((a, b) => {
    const aMismatch = Number(a.listing.selling_price) !== a.canonicalPrice ? 1 : 0;
    const bMismatch = Number(b.listing.selling_price) !== b.canonicalPrice ? 1 : 0;
    return bMismatch - aMismatch || String(a.listing.id).localeCompare(String(b.listing.id));
  });

  counts.eligible = candidates.length;
  const mismatches = candidates.filter(({ listing, canonicalPrice }) => Number(listing.selling_price) !== canonicalPrice);
  counts.remainingMismatches = mismatches.length;
  const batch = mismatches.slice(0, limit);

  for (const { listing, canonicalPrice, price, inventory } of batch) {
    const listingId = String(listing.id);
    const baseItemId = String(listing.base_item_id);
    const oldPrice = Number(listing.selling_price);
    try {
      await editBaseItem({
        itemId: baseItemId,
        title: String(listing.title ?? "").trim() || "商品情報確認中",
        detail: String(listing.description ?? listing.title ?? "").trim() || "商品情報を確認しています。",
        price: canonicalPrice,
        stock: toStorefrontStockQuantity(inventory),
        visible: true,
      });
      const canonicalMarginRate = Number(price.margin_rate);
      if (!Number.isFinite(canonicalMarginRate) || canonicalMarginRate <= 0 || canonicalMarginRate > 1) {
        throw new Error("canonical_margin_rate_invalid");
      }
      const { error: updateError } = await db.from("shop_listings").update({
        selling_price: canonicalPrice,
        contribution_profit: Number(price.expected_profit),
        // commerce_prices.margin_rate is a ratio (e.g. 0.5); shop_listings stores percent (e.g. 50).
        contribution_margin: Math.round(canonicalMarginRate * 10000) / 100,
        updated_at: new Date().toISOString(),
      }).eq("id", listingId).eq("base_item_id", baseItemId);
      if (updateError) throw new Error("base_price_updated_db_write_failed:" + updateError.message);
      counts.updated++;
      results.push({ listingId, baseItemId, ok: true, oldPrice, canonicalPrice });
    } catch (error) {
      counts.failed++;
      results.push({
        listingId,
        baseItemId,
        ok: false,
        oldPrice,
        canonicalPrice,
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 180),
      });
    }
  }

  // Read the real external BASE state back by item ID on every run. This is
  // intentionally GET-only and makes API-visible price/visibility discrepancies observable.
  const expectedPriceByListingId = new Map(candidates.map(({ listing, canonicalPrice }) => [
    String(listing.id), canonicalPrice,
  ]));
  const readbackListings = (listings ?? []).slice(0, 25);
  const externalReadback = await Promise.all(readbackListings.map(async (listing) => {
    const baseItemId = String(listing.base_item_id ?? "");
    const expectedPrice = expectedPriceByListingId.get(String(listing.id)) ?? Number(listing.selling_price);
    try {
      const item = await getBaseItemDetail(baseItemId);
      const rawPrice = Number(item.price);
      const externalPrice = Number.isFinite(rawPrice) ? rawPrice : null;
      const externalVisible = item.visible === true || item.visible === 1 || item.visible === "1";
      return {
        baseItemId,
        dbPriceBeforeRun: Number(listing.selling_price),
        expectedPrice,
        externalPrice,
        externalVisible,
        externalStock: Number.isFinite(Number(item.stock)) ? Number(item.stock) : null,
        priceMatchesExpected: externalPrice !== null && externalPrice === expectedPrice,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        baseItemId,
        dbPriceBeforeRun: Number(listing.selling_price),
        expectedPrice,
        externalPrice: null,
        externalVisible: null,
        externalStock: null,
        priceMatchesExpected: false,
        error: message.split(":")[0].slice(0, 100),
      };
    }
  }));
  const externalReadbackErrors = externalReadback.filter((row) => row.error !== null).length;
  const externalPriceMismatches = externalReadback.filter((row) => row.error === null && row.priceMatchesExpected === false).length;
  const externalHiddenItems = externalReadback.filter((row) => row.externalVisible === false).length;
  console.info("[TRACER LEGACY BASE EXTERNAL PRICE READBACK]", {
    generatedAt: new Date().toISOString(),
    scanned: externalReadback.length,
    externalReadbackErrors,
    externalPriceMismatches,
    externalHiddenItems,
    results: externalReadback,
  });

  counts.remainingMismatches = Math.max(0, mismatches.length - counts.updated);
  const ok = counts.failed === 0 && counts.remainingMismatches === 0;
  console.info("[TRACER LEGACY BASE CANONICAL PRICE SYNC]", {
    generatedAt: new Date().toISOString(),
    ...counts,
    batchSize: batch.length,
  });
  return NextResponse.json({
    ok,
    complete: counts.remainingMismatches === 0,
    ...counts,
    batchSize: batch.length,
    results,
  }, { status: counts.failed ? 207 : 200 });
}
