import "server-only";

import { isSupplierLiveOrderingEnabled } from "@/lib/config/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  exactBarcodeFamilyMatch,
  identifiersFromRecord,
  marketplaceBarcodeCandidates,
  selectUniqueExactBarcodeMatch,
} from "@/lib/market/identifiers";

export async function linkInternalSupplyForBestseller(args: {
  bestseller: Record<string, unknown>;
  fetchedAt: string;
}): Promise<{ matched: boolean; supplierListingId: string | null; supplyVariantId: string | null }> {
  const supabase = createSupabaseAdminClient();
  const marketIds = identifiersFromRecord(args.bestseller);
  // Candidate retrieval is deliberately broader than proof: any candidate found
  // by a barcode, ASIN, or MPN still needs an exact barcode on the concrete variant.
  const rawBarcodeValues = [marketIds.jan, marketIds.gtin, marketIds.ean, marketIds.upc]
    .filter((value): value is string => Boolean(value));
  const barcodeValues = [...new Set(rawBarcodeValues.flatMap(marketplaceBarcodeCandidates))];
  const lookupClauses = new Set<string>();
  for (const scheme of ["jan", "gtin", "ean", "upc"] as const) {
    for (const value of barcodeValues) lookupClauses.add(`${scheme}.eq.${value}`);
  }
  if (marketIds.asin) lookupClauses.add(`asin.eq.${marketIds.asin}`);
  // MPN is only a candidate lookup hint. Skip values that can alter PostgREST
  // filter grammar; a false negative is safer than a malformed/widened query.
  if (marketIds.mpn && /^[A-Z0-9][A-Z0-9._/-]{2,}$/.test(marketIds.mpn) && !/[(),.]/.test(marketIds.mpn)) {
    lookupClauses.add(`mpn.eq.${marketIds.mpn}`);
  }
  if (lookupClauses.size === 0) return { matched: false, supplierListingId: null, supplyVariantId: null };

  const or = [...lookupClauses].join(",");
  const firstProductPage = await supabase
    .from("internal_supply_products")
    .select("*")
    .eq("active", true)
    .or(or)
    .order("id", { ascending: true })
    .range(0, 99);

  if (firstProductPage.error) {
    console.error("[TRACER INTERNAL SUPPLY LOOKUP SKIPPED]", firstProductPage.error);
    return { matched: false, supplierListingId: null, supplyVariantId: null };
  }

  const products = [...(firstProductPage.data ?? [])];
  for (let offset = 100; (firstProductPage.data ?? []).length === 100; offset += 100) {
    const { data: page, error: pageError } = await supabase
      .from("internal_supply_products")
      .select("*")
      .eq("active", true)
      .or(or)
      .order("id", { ascending: true })
      .range(offset, offset + 99);
    if (pageError) {
      console.error("[TRACER INTERNAL SUPPLY LOOKUP PAGE FAILED]", pageError);
      return { matched: false, supplierListingId: null, supplyVariantId: null };
    }
    products.push(...(page ?? []));
    if ((page ?? []).length < 100) break;
  }

  // Reverse lookup from concrete variants is essential when the supplier exposes
  // the barcode only on a size/color/pack row and the parent product has none.
  // This is retrieval only; a candidate is not linked until its own barcode is
  // checked and the full candidate set proves exactly one match.
  const variantLookupClauses = new Set<string>();
  for (const scheme of ["jan", "gtin", "ean", "upc"] as const) {
    for (const value of barcodeValues) variantLookupClauses.add(`${scheme}.eq.${value}`);
  }
  if (variantLookupClauses.size > 0) {
    const variantOr = [...variantLookupClauses].join(",");
    const firstVariantCandidatePage = await supabase
      .from("internal_supply_variants")
      .select("id,supply_product_id")
      .eq("active", true)
      .eq("orderable", true)
      .gt("inventory", 0)
      .or(variantOr)
      .order("id", { ascending: true })
      .range(0, 99);
    if (firstVariantCandidatePage.error) {
      console.error("[TRACER INTERNAL VARIANT LOOKUP SKIPPED]", firstVariantCandidatePage.error);
      return { matched: false, supplierListingId: null, supplyVariantId: null };
    }
    const variantCandidateRows = [...(firstVariantCandidatePage.data ?? [])];
    for (let offset = 100; (firstVariantCandidatePage.data ?? []).length === 100; offset += 100) {
      const { data: page, error: pageError } = await supabase
        .from("internal_supply_variants")
        .select("id,supply_product_id")
        .eq("active", true)
        .eq("orderable", true)
        .gt("inventory", 0)
        .or(variantOr)
        .order("id", { ascending: true })
        .range(offset, offset + 99);
      if (pageError) {
        console.error("[TRACER INTERNAL VARIANT LOOKUP PAGE FAILED]", pageError);
        return { matched: false, supplierListingId: null, supplyVariantId: null };
      }
      variantCandidateRows.push(...(page ?? []));
      if ((page ?? []).length < 100) break;
    }

    const parentIds = [...new Set(variantCandidateRows
      .map((row) => typeof row.supply_product_id === "string" ? row.supply_product_id : "")
      .filter(Boolean))];
    for (let offset = 0; offset < parentIds.length; offset += 100) {
      const { data: parentPage, error: parentError } = await supabase
        .from("internal_supply_products")
        .select("*")
        .eq("active", true)
        .in("id", parentIds.slice(offset, offset + 100));
      if (parentError) {
        console.error("[TRACER INTERNAL VARIANT PARENT LOOKUP FAILED]", parentError);
        return { matched: false, supplierListingId: null, supplyVariantId: null };
      }
      const known = new Set(products.map((product) => String(product.id)));
      for (const parent of parentPage ?? []) {
        if (!known.has(String(parent.id))) {
          products.push(parent);
          known.add(String(parent.id));
        }
      }
    }
  }

  const candidateMatches: Array<{
    product: (typeof products)[number];
    productIds: ReturnType<typeof identifiersFromRecord>;
    variant: Record<string, unknown>;
    method: "jan" | "gtin" | "ean" | "upc";
  }> = [];

  // Do not write a listing while still scanning candidates. Returning from the
  // first matching product would turn duplicate barcode evidence across two
  // supplier products into a false "unique" link.
  for (const product of products) {
    const productIds = identifiersFromRecord(product as Record<string, unknown>);
    // A parent may have no barcode (or no identifiers at all) while its
    // concrete variant carries the proof. Exact variant barcode matching below
    // is the only identity gate.
    const firstVariantPage = await supabase
      .from("internal_supply_variants")
      .select("*")
      .eq("supply_product_id", product.id)
      .eq("active", true)
      .eq("orderable", true)
      .gt("inventory", 0)
      .order("id", { ascending: true })
      .range(0, 99);
    if (firstVariantPage.error) throw new Error(firstVariantPage.error.message);

    const variants = [...(firstVariantPage.data ?? [])];
    for (let offset = 100; (firstVariantPage.data ?? []).length === 100; offset += 100) {
      const { data: page, error: pageError } = await supabase
        .from("internal_supply_variants")
        .select("*")
        .eq("supply_product_id", product.id)
        .eq("active", true)
        .eq("orderable", true)
        .gt("inventory", 0)
        .order("id", { ascending: true })
        .range(offset, offset + 99);
      if (pageError) throw new Error(pageError.message);
      variants.push(...(page ?? []));
      if ((page ?? []).length < 100) break;
    }

    for (const variant of variants) {
      const method = exactBarcodeFamilyMatch(
        marketIds,
        identifiersFromRecord(variant as Record<string, unknown>),
      );
      if (method) candidateMatches.push({
        product,
        productIds,
        variant: variant as Record<string, unknown>,
        method,
      });
    }
  }

  // Exactly one match across the entire candidate set is required. Zero matches,
  // duplicate variants, or the same barcode on separate supplier products all fail closed.
  const uniqueCandidate = selectUniqueExactBarcodeMatch(candidateMatches);
  if (!uniqueCandidate) {
    return { matched: false, supplierListingId: null, supplyVariantId: null };
  }

  const { product, productIds, variant, method: exactMethod } = uniqueCandidate;
  const variantIds = identifiersFromRecord(variant);
  // Persist the actual pair that proved identity. Do not report the first
  // populated variant barcode when a later field was the one that matched.
  const barcodeSchemes = ["jan", "gtin", "ean", "upc"] as const;
  let matchedBarcodeEvidence: {
    marketScheme: (typeof barcodeSchemes)[number];
    supplierScheme: (typeof barcodeSchemes)[number];
    marketValue: string;
    supplierValue: string;
    normalizedGtin14: string;
  } | null = null;
  for (const marketScheme of barcodeSchemes) {
    const marketValue = marketIds[marketScheme];
    if (!marketValue) continue;
    for (const supplierScheme of barcodeSchemes) {
      const supplierValue = variantIds[supplierScheme];
      if (!supplierValue || marketValue.padStart(14, "0") !== supplierValue.padStart(14, "0")) continue;
      matchedBarcodeEvidence = {
        marketScheme,
        supplierScheme,
        marketValue,
        supplierValue,
        normalizedGtin14: marketValue.padStart(14, "0"),
      };
      break;
    }
    if (matchedBarcodeEvidence) break;
  }
  // Defensive invariant: a listing must never be written if the proof cannot
  // be reconstructed for its audit record.
  if (!matchedBarcodeEvidence) {
    return { matched: false, supplierListingId: null, supplyVariantId: null };
  }
  const rationale = exactMethod === "gtin"
    ? "exact barcode-family match across JAN/EAN/UPC/GTIN (GTIN-14 normalized)"
    : `${exactMethod.toUpperCase()} matches exact canonical variant barcode`;
  const inventory = Number(variant.inventory ?? product.inventory ?? 0);
  if (!Number.isFinite(inventory) || inventory <= 0) {
    return { matched: false, supplierListingId: null, supplyVariantId: null };
  }

  const { data: existingListing, error: existingListingError } = await supabase
    .from("supplier_listings")
    .select("id")
    .eq("supplier", "tracer_internal")
    .eq("bestseller_id", args.bestseller.id)
    .eq("external_id", String(product.source_ref ?? product.id))
    .limit(1)
    .maybeSingle();
  if (existingListingError) throw new Error(existingListingError.message);

  const listingPayload = {
    supplier: "tracer_internal",
    external_id: String(product.source_ref ?? product.id),
    sku: typeof variant.variant_sku === "string" ? variant.variant_sku : product.sku,
    title: String(variant.title ?? product.title),
    bestseller_id: args.bestseller.id,
    product_id: args.bestseller.product_id ?? product.product_id,
    asin: productIds.asin,
    // These fields describe the selected concrete supplier variant, not its
    // parent product. Parent identifiers are retained separately for audit.
    jan: variantIds.jan,
    gtin: variantIds.gtin,
    ean: variantIds.ean,
    upc: variantIds.upc,
    mpn: variantIds.mpn ?? productIds.mpn,
    cost: variant.cost ?? product.cost,
    shipping_cost: variant.shipping_cost ?? product.shipping_cost,
    currency: variant.currency ?? product.currency ?? "JPY",
    inventory,
    lead_time_days: product.lead_time_days,
    ship_to: product.ship_to ?? "JP",
    tracking_available: variant.tracking_available === true || product.tracking_available === true,
    order_method: product.order_method ?? "internal",
    api_available: product.api_available === true,
    identity_method: exactMethod,
    identity_status: "linked",
    identity_confidence: 0.98,
    configured: true,
    supplier_product_id: String(product.id),
    supplier_variant_id: variant.id ? String(variant.id) : (variant.variant_id ? String(variant.variant_id) : null),
    // Keep this listing non-orderable until the exact verified link is durably recorded.
    // Existing listings are downgraded first as well, so audit failures fail closed.
    orderable: false,
    price_confirmed: variant.cost != null || product.cost != null,
    inventory_confirmed: true,
    fetched_at: args.fetchedAt,
    metadata: {
      source: "tracer_internal_supply",
      rationale,
      source_name: product.source_name,
      canonical_product_identifiers: productIds,
      matched_variant_identifiers: variantIds,
      matched_variant_barcode: matchedBarcodeEvidence.supplierValue,
      exact_barcode_evidence: matchedBarcodeEvidence,
    },
  };

  const listingResult = existingListing?.id
    ? await supabase.from("supplier_listings").update(listingPayload).eq("id", existingListing.id).select("id").single()
    : await supabase.from("supplier_listings").insert(listingPayload).select("id").single();
  if (listingResult.error) throw new Error(listingResult.error.message);

  const linkPayload = {
    bestseller_id: args.bestseller.id,
    supply_product_id: product.id,
    supply_variant_id: variant.id,
    identity_method: exactMethod,
    identity_confidence: 0.98,
    identity_rationale: rationale,
    status: "verified",
  };
  // A verified identity link is part of the sales-safety contract, not optional telemetry.
  // If insert reports a duplicate, accept it only when the exact same product+variant
  // is already durably recorded as verified. Any other error leaves orderable=false.
  const linkResult = await supabase.from("internal_supply_links").insert(linkPayload);
  let verifiedLinkPersisted = !linkResult.error;
  if (linkResult.error && /duplicate|unique/i.test(linkResult.error.message)) {
    const { data: existingLink, error: existingLinkError } = await supabase
      .from("internal_supply_links")
      .select("bestseller_id,supply_product_id,supply_variant_id,identity_method,status")
      .eq("bestseller_id", args.bestseller.id)
      .eq("supply_product_id", product.id)
      .eq("supply_variant_id", variant.id)
      .eq("identity_method", exactMethod)
      .eq("status", "verified")
      .limit(1)
      .maybeSingle();
    verifiedLinkPersisted = !existingLinkError && Boolean(existingLink);
  }
  if (!verifiedLinkPersisted) {
    console.error("[TRACER INTERNAL SUPPLY LINK REQUIRED BUT NOT PERSISTED]", linkResult.error?.message ?? "unknown link persistence failure");
    return { matched: false, supplierListingId: null, supplyVariantId: null };
  }

  // Identity proof and supplier orderability are separate gates. A durable
  // barcode link alone must never activate ordering; require the explicit live
  // ordering switch plus current price, shipping, tracking, destination and API
  // evidence. If any gate is missing, keep the identity link but leave the
  // listing non-orderable so matching metrics can grow without faking sellability.
  const cost = Number(variant.cost ?? product.cost);
  const shippingCost = Number(variant.shipping_cost ?? product.shipping_cost);
  const leadTimeDays = Number(product.lead_time_days);
  const shipTo = typeof product.ship_to === "string" ? product.ship_to.trim().toUpperCase() : "";
  const liveOrderReady =
    isSupplierLiveOrderingEnabled("TRACER_INTERNAL") &&
    product.api_available === true &&
    (variant.tracking_available === true || product.tracking_available === true) &&
    Number.isFinite(cost) && cost >= 0 &&
    Number.isFinite(shippingCost) && shippingCost >= 0 &&
    Number.isFinite(leadTimeDays) && leadTimeDays >= 0 &&
    (shipTo === "JP" || shipTo.split(/[\\s,;|]+/).includes("JP"));
  if (!liveOrderReady) {
    return { matched: true, supplierListingId: String(listingResult.data.id), supplyVariantId: String(variant.id) };
  }

  // Activate only after identity evidence and the independent live-order gate pass.
  // If this final write fails, the listing remains non-orderable.
  const activationResult = await supabase
    .from("supplier_listings")
    .update({ orderable: true })
    .eq("id", listingResult.data.id)
    .select("id")
    .single();
  if (activationResult.error || !activationResult.data) {
    throw new Error(activationResult.error?.message ?? "supplier listing activation returned no row");
  }

  return { matched: true, supplierListingId: String(activationResult.data.id), supplyVariantId: String(variant.id) };
}
