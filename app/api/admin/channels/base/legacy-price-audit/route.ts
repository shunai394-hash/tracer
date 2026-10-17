import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Read-only audit of already-published legacy BASE items.
 * Reads each existing BASE item by ID and compares external visibility/price
 * against the DB listing and current canonical price. Never edits or creates items.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit") || 25);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 25;
  const db = createSupabaseAdminClient();

  const { data: listings, error: listingError } = await db.from("shop_listings")
    .select("id,title,base_item_id,supplier_variant_id,selling_price,contribution_profit,published")
    .eq("published", true)
    .not("base_item_id", "is", null)
    .not("supplier_variant_id", "is", null)
    .order("base_item_id", { ascending: true })
    .limit(limit);
  if (listingError) {
    return NextResponse.json({ ok: false, error: "BASE_PRICE_AUDIT_DB_READ_FAILED" }, {
      status: 500, headers: { "Cache-Control": "no-store" },
    });
  }

  const supplierKeys = [...new Set((listings ?? []).map((row) => String(row.supplier_variant_id ?? "").trim()).filter(Boolean))];
  const { data: variants, error: variantError } = supplierKeys.length
    ? await db.from("commerce_variants").select("id,source_variant_key,sku").in("source_variant_key", supplierKeys)
    : { data: [], error: null };
  if (variantError) {
    return NextResponse.json({ ok: false, error: "BASE_PRICE_AUDIT_VARIANT_READ_FAILED" }, {
      status: 500, headers: { "Cache-Control": "no-store" },
    });
  }

  const variantBySupplierKey = new Map<string, { id: string; source_variant_key: string; sku: string | null }>();
  const duplicateKeys = new Set<string>();
  for (const variant of variants ?? []) {
    const key = String(variant.source_variant_key ?? "");
    if (variantBySupplierKey.has(key)) duplicateKeys.add(key);
    else variantBySupplierKey.set(key, variant as { id: string; source_variant_key: string; sku: string | null });
  }
  for (const key of duplicateKeys) variantBySupplierKey.delete(key);
  const variantIds = [...new Set([...variantBySupplierKey.values()].map((variant) => variant.id))];

  const [{ data: offers, error: offerError }, { data: prices, error: priceError }] = await Promise.all([
    variantIds.length
      ? db.from("supplier_offers").select("id,variant_id,supplier_variant_id,source_status,unit_cost,shipping_cost,inventory,raw_data,updated_at,created_at")
          .in("variant_id", variantIds).order("updated_at", { ascending: false }).order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? db.from("commerce_prices").select("variant_id,supplier_offer_id,selling_price,expected_profit,margin_rate").in("variant_id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (offerError || priceError) {
    return NextResponse.json({ ok: false, error: "BASE_PRICE_AUDIT_PRICE_READ_FAILED" }, {
      status: 500, headers: { "Cache-Control": "no-store" },
    });
  }

  const offerByVariant = new Map<string, NonNullable<typeof offers>[number]>();
  for (const offer of offers ?? []) if (!offerByVariant.has(String(offer.variant_id))) offerByVariant.set(String(offer.variant_id), offer);
  const priceByVariant = new Map<string, NonNullable<typeof prices>[number]>();
  for (const price of prices ?? []) priceByVariant.set(String(price.variant_id), price);

  const results = await Promise.all((listings ?? []).map(async (listing) => {
    const baseItemId = String(listing.base_item_id ?? "");
    const supplierKey = String(listing.supplier_variant_id ?? "").trim();
    const variant = variantBySupplierKey.get(supplierKey);
    const offer = variant ? offerByVariant.get(String(variant.id)) : undefined;
    const price = variant ? priceByVariant.get(String(variant.id)) : undefined;
    const offerMatches = Boolean(offer && String(offer.supplier_variant_id ?? "") === supplierKey);
    const priceMatchesOffer = Boolean(offer && price && String(price.supplier_offer_id ?? "") === String(offer.id));
    const raw = offer?.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
      ? offer.raw_data as Record<string, unknown> : {};
    const shippingEvidence = raw.shippingKnown === true || raw.shippingEstimated === true;

    try {
      const item = await getBaseItemDetail(baseItemId);
      const externalPrice = Number(item.price);
      const externalVisible = item.visible === true || item.visible === 1 || item.visible === "1";
      const canonicalPrice = priceMatchesOffer ? Number(price?.selling_price) : null;
      return {
        baseItemId,
        title: String(item.title ?? listing.title ?? ""),
        externalVisible,
        externalPrice: Number.isFinite(externalPrice) ? externalPrice : null,
        externalStock: Number.isFinite(Number(item.stock)) ? Number(item.stock) : null,
        dbPrice: Number(listing.selling_price),
        canonicalPrice,
        expectedProfit: priceMatchesOffer ? Number(price?.expected_profit) : null,
        supplierVariantId: supplierKey,
        internalSku: variant?.sku ?? null,
        offerMatchesSupplierVariant: offerMatches,
        offerStatus: offer?.source_status ?? null,
        supplierInventory: offer ? Number(offer.inventory) : null,
        shippingEvidence,
        priceMatchesCanonical: canonicalPrice !== null && externalPrice === canonicalPrice,
        dbMatchesCanonical: canonicalPrice !== null && Number(listing.selling_price) === canonicalPrice,
        ok: externalVisible && canonicalPrice !== null && externalPrice === canonicalPrice && offerMatches && shippingEvidence &&
          offer?.source_status === "verified" && Number(offer.inventory) > 0 && Number(price?.expected_profit) > 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "BASE_ITEM_DETAIL_FAILED";
      return {
        baseItemId,
        title: String(listing.title ?? ""),
        dbPrice: Number(listing.selling_price),
        canonicalPrice: priceMatchesOffer ? Number(price?.selling_price) : null,
        supplierVariantId: supplierKey,
        internalSku: variant?.sku ?? null,
        offerMatchesSupplierVariant: offerMatches,
        offerStatus: offer?.source_status ?? null,
        shippingEvidence,
        externalReadError: message.split(":")[0].slice(0, 100),
        ok: false,
      };
    }
  }));

  const priceMismatches = results.filter((row) => "priceMatchesCanonical" in row && row.priceMatchesCanonical === false).length;
  const hiddenItems = results.filter((row) => "externalVisible" in row && row.externalVisible === false).length;
  const readErrors = results.filter((row) => "externalReadError" in row).length;
  return NextResponse.json({
    ok: readErrors === 0 && priceMismatches === 0,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    scanned: results.length,
    priceMismatches,
    hiddenItems,
    readErrors,
    rowsNotOrderableByEvidence: results.filter((row) => !row.ok).length,
    results,
  }, { status: readErrors ? 207 : 200, headers: { "Cache-Control": "no-store, private" } });
}
