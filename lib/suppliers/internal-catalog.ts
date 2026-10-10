import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  exactBarcodeFamilyMatch,
  identifiersFromRecord,
  matchProductIdentity,
} from "@/lib/market/identifiers";

export async function linkInternalSupplyForBestseller(args: {
  bestseller: Record<string, unknown>;
  fetchedAt: string;
}): Promise<{ matched: boolean; supplierListingId: string | null; supplyVariantId: string | null }> {
  const supabase = createSupabaseAdminClient();
  const marketIds = identifiersFromRecord(args.bestseller);
  // Query every barcode scheme with every observed canonical barcode value.
  // A same-digit JAN on the marketplace must still find a supplier row whose
  // value is stored in EAN/UPC/GTIN, otherwise exact cross-scheme matches are
  // lost before the variant-level proof can run.
  const barcodeValues = [...new Set([marketIds.jan, marketIds.gtin, marketIds.ean, marketIds.upc].filter((value): value is string => Boolean(value)))];
  const lookupClauses = new Set<string>();
  for (const scheme of ["jan", "gtin", "ean", "upc"] as const) {
    for (const value of barcodeValues) lookupClauses.add(`${scheme}.eq.${value.replace(/[,()]/g, "")}`);
  }
  if (marketIds.asin) lookupClauses.add(`asin.eq.${marketIds.asin}`);
  if (marketIds.mpn) lookupClauses.add(`mpn.eq.${marketIds.mpn.replace(/[,()]/g, "")}`);

  if (lookupClauses.size === 0) return { matched: false, supplierListingId: null, supplyVariantId: null };

  const or = [...lookupClauses].join(",");

  const { data: products, error } = await supabase
    .from("internal_supply_products")
    .select("*")
    .eq("active", true)
    .or(or)
    .limit(20);

  if (error) {
    // Internal supply is an optional acceleration path. A broken/missing
    // permission on this private catalog must never stop the external CJ
    // investigation path; otherwise one DB permission issue makes the entire
    // autonomous patrol look like it discovered nothing.
    console.error("[TRACER INTERNAL SUPPLY LOOKUP SKIPPED]", error);
    return { matched: false, supplierListingId: null, supplyVariantId: null };
  }

  for (const product of products ?? []) {
    const productIds = identifiersFromRecord(product as Record<string, unknown>);
    const identity = matchProductIdentity({
      market: {
        ...marketIds,
        brand: typeof args.bestseller.brand === "string" ? args.bestseller.brand : null,
        title: String(args.bestseller.title ?? ""),
      },
      supply: {
        ...productIds,
        brand: typeof product.brand === "string" ? product.brand : null,
        title: String(product.title ?? ""),
      },
    });

    if (!identity.salesEligible) continue;

    const { data: variants, error: variantError } = await supabase
      .from("internal_supply_variants")
      .select("*")
      .eq("supply_product_id", product.id)
      .eq("active", true)
      .eq("orderable", true)
      .gt("inventory", 0)
      .limit(50);

    if (variantError) throw new Error(variantError.message);

    // A product-level ASIN/MPN can identify the model, but cannot prove
    // which concrete variant is the same color, size, or pack count. Require
    // exactly one variant with a valid exact barcode-family match. Compare all
    // populated barcode fields to avoid first-field masking.
    const confirmedVariants = (variants ?? []).map((variant) => ({
      variant,
      method: exactBarcodeFamilyMatch(
        marketIds,
        identifiersFromRecord(variant as Record<string, unknown>),
      ),
    })).filter((item) => item.method !== null);

    const uniqueVariant = confirmedVariants.length === 1 ? confirmedVariants[0] : null;
    if (!uniqueVariant) continue;

    const selected = {
      variant: uniqueVariant.variant,
      identity: {
        linked: true,
        salesEligible: true,
        method: uniqueVariant.method,
        confidence: 0.98,
        rationale: uniqueVariant.method === "gtin"
          ? "exact barcode-family match across JAN/EAN/UPC/GTIN (GTIN-14 normalized)"
          : `${uniqueVariant.method.toUpperCase()} matches exact canonical variant barcode`,
      },
    };

    const variant = selected.variant as Record<string, unknown>;
    const inventory = Number(variant.inventory ?? product.inventory ?? 0);
    if (!Number.isFinite(inventory) || inventory <= 0) continue;

    const { data: existingListing } = await supabase
      .from("supplier_listings")
      .select("id")
      .eq("supplier", "tracer_internal")
      .eq("bestseller_id", args.bestseller.id)
      .eq("external_id", String(product.source_ref ?? product.id))
      .limit(1)
      .maybeSingle();

    const listingPayload = {
        supplier: "tracer_internal",
        external_id: String(product.source_ref ?? product.id),
        sku: typeof variant.variant_sku === "string" ? variant.variant_sku : product.sku,
        title: String(variant.title ?? product.title),
        bestseller_id: args.bestseller.id,
        product_id: args.bestseller.product_id ?? product.product_id,
        asin: productIds.asin,
        jan: productIds.jan,
        gtin: productIds.gtin,
        ean: productIds.ean,
        upc: productIds.upc,
        mpn: productIds.mpn,
        cost: variant.cost ?? product.cost,
        shipping_cost: variant.shipping_cost ?? product.shipping_cost,
        currency: variant.currency ?? product.currency ?? "JPY",
        inventory,
        lead_time_days: product.lead_time_days,
        ship_to: product.ship_to ?? "JP",
        tracking_available: variant.tracking_available === true || product.tracking_available === true,
        order_method: product.order_method ?? "internal",
        api_available: product.api_available === true,
        identity_method: selected.identity.method,
        identity_status: "linked",
        identity_confidence: selected.identity.confidence,
        configured: true,
        supplier_product_id: String(product.id),
        supplier_variant_id: variant.id ? String(variant.id) : (variant.variant_id ? String(variant.variant_id) : null),
        orderable: true,
        price_confirmed: variant.cost != null || product.cost != null,
        inventory_confirmed: true,
        fetched_at: args.fetchedAt,
        metadata: {
          source: "tracer_internal_supply",
          rationale: selected.identity.rationale,
          source_name: product.source_name,
        },
      };

    const listingResult = existingListing?.id
      ? await supabase.from("supplier_listings").update(listingPayload).eq("id", existingListing.id).select("id").single()
      : await supabase.from("supplier_listings").insert(listingPayload).select("id").single();

    if (listingResult.error) throw new Error(listingResult.error.message);
    const listing = listingResult.data;

    const linkPayload = {
      bestseller_id: args.bestseller.id,
      supply_product_id: product.id,
      supply_variant_id: variant.id,
      identity_method: selected.identity.method,
      identity_confidence: selected.identity.confidence,
      identity_rationale: selected.identity.rationale,
      status: "verified",
    };

    // This link is telemetry/cache, not a prerequisite for creating the
    // supplier listing. Older production databases may not yet have the
    // composite unique constraint required by PostgREST upsert(onConflict).
    // Never let that schema drift discard an otherwise valid supplier match.
    const linkResult = await supabase
      .from("internal_supply_links")
      .insert(linkPayload);
    if (linkResult.error && !/duplicate|unique/i.test(linkResult.error.message)) {
      console.warn("[TRACER INTERNAL SUPPLY LINK SKIPPED]", linkResult.error.message);
    }

    return { matched: true, supplierListingId: String(listing.id), supplyVariantId: String(variant.id) };
  }

  return { matched: false, supplierListingId: null, supplyVariantId: null };
}
