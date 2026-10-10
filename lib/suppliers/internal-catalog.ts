import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  identifiersFromRecord,
  marketplaceBarcodeCandidates,
  matchProductIdentity,
} from "@/lib/market/identifiers";
import { hasUniqueIdentitySelection, internalProductCandidateStatus, isVerifiedInternalSupplyLink, supplierListingStateForIdentity } from "@/lib/suppliers/cj-identity-reverify-policy";

export type InternalSupplyLinkStatus =
  | "saved"
  | "existing_verified"
  | "write_failed"
  | "table_missing"
  | "duplicate_unverified"
  | "readback_failed"
  | "lookup_failed"
  | "candidate_set_truncated"
  | "no_product_candidate"
  | "ambiguous_product"
  | "no_unique_variant"
  | "no_match"
  | "listing_activation_failed";

export async function linkInternalSupplyForBestseller(args: {
  bestseller: Record<string, unknown>;
  fetchedAt: string;
}): Promise<{
  matched: boolean;
  supplierListingId: string | null;
  supplyVariantId: string | null;
  linkStatus?: InternalSupplyLinkStatus;
}> {
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
    console.error("[TRACER INTERNAL SUPPLY LOOKUP SKIPPED]", { code: error.code ?? null, message: error.message });
    return { matched: false, supplierListingId: null, supplyVariantId: null, linkStatus: "lookup_failed" };
  }

  // The query is deliberately bounded. If it fills the full 20-row limit,
  // the candidate set may be truncated, so uniqueness cannot be proven safely.
  if ((products ?? []).length >= 20) {
    return { matched: false, supplierListingId: null, supplyVariantId: null, linkStatus: "candidate_set_truncated" };
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

  const candidateStatus = internalProductCandidateStatus(identityEligibleProductCount);
  if (candidateStatus !== "unique_product_candidate") {
    return { matched: false, supplierListingId: null, supplyVariantId: null, linkStatus: candidateStatus };
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

    if (variantError) {
      console.error("[TRACER INTERNAL SUPPLY VARIANT LOOKUP FAILED]", { code: variantError.code ?? null, message: variantError.message });
      return { matched: false, supplierListingId: null, supplyVariantId: null, linkStatus: "lookup_failed" };
    }

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

    if (!selected) {
      return { matched: false, supplierListingId: null, supplyVariantId: null, linkStatus: "no_unique_variant" };
    }

    const variant = selected.variant as Record<string, unknown>;
    const inventory = Number(variant.inventory ?? product.inventory ?? 0);
    if (!Number.isFinite(inventory) || inventory <= 0) continue;

    const { data: existingListing, error: existingListingError } = await supabase
      .from("supplier_listings")
      .select("id")
      .eq("supplier", "tracer_internal")
      .eq("bestseller_id", args.bestseller.id)
      .eq("external_id", String(product.source_ref ?? product.id))
      .limit(1)
      .maybeSingle();

    if (existingListingError) {
      console.error("[TRACER INTERNAL SUPPLY LISTING LOOKUP FAILED]", { code: existingListingError.code ?? null, message: existingListingError.message });
      return { matched: false, supplierListingId: null, supplyVariantId: String(variant.id), linkStatus: "lookup_failed" };
    }

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
        ...supplierListingStateForIdentity(false),
        identity_confidence: selected.identity.confidence,

        supplier_product_id: String(product.id),
        supplier_variant_id: variant.id ? String(variant.id) : (variant.variant_id ? String(variant.variant_id) : null),

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

    if (listingResult.error || !listingResult.data?.id) {
      console.error("[TRACER INTERNAL SUPPLY LISTING WRITE FAILED]", { code: listingResult.error?.code ?? null, message: listingResult.error?.message ?? "no listing row returned" });
      return { matched: false, supplierListingId: null, supplyVariantId: String(variant.id), linkStatus: "write_failed" };
    }
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

    // A supplier listing alone is not proof of a canonical internal link.
    // Only report matched after a successful insert or a read-back that
    // confirms the existing row is exactly the link requested by this run.
    const linkResult = await supabase
      .from("internal_supply_links")
      .insert(linkPayload)
      .select("bestseller_id,supply_product_id,supply_variant_id,identity_method,identity_confidence,identity_rationale,status")
      .single();

    if (!linkResult.error && linkResult.data) {
      const { data: activatedListing, error: activationError } = await supabase
        .from("supplier_listings")
        .update(supplierListingStateForIdentity(true))
        .eq("id", String(listing.id))
        .select("id")
        .single();
      if (activationError || !activatedListing?.id) {
        console.error("[TRACER INTERNAL SUPPLY LISTING ACTIVATION FAILED]", { code: activationError?.code ?? null, message: activationError?.message ?? "no activated row returned" });
        return { matched: false, supplierListingId: String(listing.id), supplyVariantId: String(variant.id), linkStatus: "listing_activation_failed" };
      }
      return {
        matched: true,
        supplierListingId: String(listing.id),
        supplyVariantId: String(variant.id),
        linkStatus: "saved",
      };
    }

    const linkError = linkResult.error;
    const isDuplicate = linkError?.code === "23505"
      || /duplicate key|unique constraint|already exists/i.test(linkError?.message ?? "");
    const isMissingTable = linkError?.code === "42P01"
      || linkError?.code === "PGRST205"
      || /relation .*internal_supply_links.* does not exist|could not find the table .*internal_supply_links/i.test(linkError?.message ?? "");

    if (isDuplicate) {
      const readback = await supabase
        .from("internal_supply_links")
        .select("bestseller_id,supply_product_id,supply_variant_id,identity_method,identity_confidence,identity_rationale,status")
        .eq("bestseller_id", String(linkPayload.bestseller_id))
        .eq("supply_product_id", String(linkPayload.supply_product_id))
        .eq("supply_variant_id", String(linkPayload.supply_variant_id))
        .maybeSingle();

      const row = readback.data as Record<string, unknown> | null;
      const exactExistingLink = !readback.error
        && isVerifiedInternalSupplyLink(
          row as Parameters<typeof isVerifiedInternalSupplyLink>[0],
          linkPayload,
        );

      if (exactExistingLink) {
        const { data: activatedListing, error: activationError } = await supabase
          .from("supplier_listings")
          .update(supplierListingStateForIdentity(true))
          .eq("id", String(listing.id))
          .select("id")
          .single();
        if (activationError || !activatedListing?.id) {
          console.error("[TRACER INTERNAL SUPPLY LISTING ACTIVATION FAILED]", { code: activationError?.code ?? null, message: activationError?.message ?? "no activated row returned" });
          return { matched: false, supplierListingId: String(listing.id), supplyVariantId: String(variant.id), linkStatus: "listing_activation_failed" };
        }
        return {
          matched: true,
          supplierListingId: String(listing.id),
          supplyVariantId: String(variant.id),
          linkStatus: "existing_verified",
        };
      }

      console.warn("[TRACER INTERNAL SUPPLY LINK DUPLICATE UNVERIFIED]", {
        bestsellerId: String(linkPayload.bestseller_id),
        supplyProductId: String(linkPayload.supply_product_id),
        supplyVariantId: String(linkPayload.supply_variant_id),
        readbackError: readback.error?.message ?? null,
      });
      return {
        matched: false,
        supplierListingId: String(listing.id),
        supplyVariantId: String(variant.id),
        linkStatus: readback.error ? "readback_failed" : "duplicate_unverified",
      };
    }

    console.warn("[TRACER INTERNAL SUPPLY LINK WRITE FAILED]", {
      code: linkError?.code ?? null,
      message: linkError?.message ?? "No link row returned after insert",
      missingTable: isMissingTable,
    });
    return {
      matched: false,
      supplierListingId: String(listing.id),
      supplyVariantId: String(variant.id),
      linkStatus: isMissingTable ? "table_missing" : "write_failed",
    };
  }

  return { matched: false, supplierListingId: null, supplyVariantId: null, linkStatus: "no_match" };
}
