import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  identifiersFromRecord,
  marketplaceBarcodeCandidates,
  matchProductIdentity,
} from "@/lib/market/identifiers";
import { hasUniqueIdentitySelection, hasUniqueMarketplaceIdentity } from "@/lib/suppliers/cj-identity-reverify-policy";

export async function linkInternalSupplyForBestseller(args: {
  bestseller: Record<string, unknown>;
  fetchedAt: string;
}): Promise<{ matched: boolean; supplierListingId: string | null; supplyVariantId: string | null }> {
  const supabase = createSupabaseAdminClient();
  const marketIds = identifiersFromRecord(args.bestseller);
  const queries = [
    ["jan", marketIds.jan],
    ["gtin", marketIds.gtin],
    ["ean", marketIds.ean],
    ["upc", marketIds.upc],
    ["mpn", marketIds.mpn],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;

  if (queries.length === 0) return { matched: false, supplierListingId: null, supplyVariantId: null };

  const or = queries
    .map(([column, value]) => `${column}.eq.${value.replace(/[,()]/g, "")}`)
    .join(",");

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

  // The query is deliberately bounded. If it fills the full 20-row limit,
  // the candidate set may be truncated, so uniqueness cannot be proven safely.
  if ((products ?? []).length >= 20) {
    return { matched: false, supplierListingId: null, supplyVariantId: null };
  }

  // Do not select the first eligible product from an ambiguous result set.
  // Duplicate supplier barcodes/MPNs can otherwise link the marketplace item
  // to whichever row PostgREST happens to return first. Only a single
  // identity-eligible product may proceed to variant-level matching.
  const identityEligibleProductCount = (products ?? []).filter((product) => {
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
    return identity.salesEligible;
  }).length;

  if (!hasUniqueMarketplaceIdentity(identityEligibleProductCount)) {
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

    const confirmedVariants = (variants ?? []).map((variant) => {
      const variantIds = identifiersFromRecord(variant as Record<string, unknown>);
      return {
        variant,
        identity: matchProductIdentity({
          market: {
            ...marketIds,
            brand: typeof args.bestseller.brand === "string" ? args.bestseller.brand : null,
            title: String(args.bestseller.title ?? ""),
          },
          supply: {
            ...variantIds,
            brand: typeof product.brand === "string" ? product.brand : null,
            title: String(variant.title ?? product.title ?? ""),
          },
        }),
      };
    }).filter((item) => item.identity.salesEligible);

    const marketBarcodeCandidateSet = new Set(
      [marketIds.jan, marketIds.gtin, marketIds.ean, marketIds.upc]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => marketplaceBarcodeCandidates(value)),
    );
    const exactIdentifierMatches = confirmedVariants.filter((item) => {
      const variantIds = identifiersFromRecord(item.variant as Record<string, unknown>);
      return [variantIds.jan, variantIds.gtin, variantIds.ean, variantIds.upc]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => marketplaceBarcodeCandidates(value))
        .some((value) => marketBarcodeCandidateSet.has(value));
    });
    // Multiple variants may share weak/model-level identity. Only select from
    // a multi-variant set when exactly one variant has an exact normalized
    // barcode match; never take the first matching row by response order.
    const selected = hasUniqueIdentitySelection(confirmedVariants.length, exactIdentifierMatches.length)
      ? confirmedVariants.length === 1
        ? confirmedVariants[0]
        : exactIdentifierMatches[0]
      : null;

    if (!selected) continue;

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
