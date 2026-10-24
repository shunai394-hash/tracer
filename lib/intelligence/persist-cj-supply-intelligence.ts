import "server-only";

import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCJProductVariants, fetchCJVariantByVid } from "@/lib/sources/cj";
import { identifiersFromRecord, matchProductIdentity, marketplaceBarcodeCandidates, pickSupplierBarcodeIdentifier } from "@/lib/market/identifiers";
import { hasUniqueMarketplaceIdentity } from "@/lib/suppliers/cj-identity-reverify-policy";
import { isSpecificJapaneseProductTitle } from "@/lib/intelligence/japanese-product";

export type PersistCjSupplyIntelligenceArgs = {
  productId: string;
  title: string;
  imageUrl: string;
  cost: number;
  shippingCost: number;
  supplierListingId: string;
  supplierProductId: string;
  supplierVariantId: string;
  inventory: number;
  query: string;
  fxRate: number;
  sellingPriceJpy: number;
  variantBarcode?: string | null;
  supplierIdentifiers?: { gtin?: string | null; jan?: string | null; ean?: string | null; upc?: string | null; mpn?: string | null } | null;
};

export type MarketplaceIdentity = { bestsellerId: string; productId: string; canonicalVariantEvidenceId: string; sourceVariantId: string; method: "gtin" | "jan" | "ean" | "upc"; confidence: number; rationale: string };

function normalizeBarcode(value: unknown): string { return typeof value === "string" ? value.trim().replace(/[^0-9]/g, "") : ""; }

async function readSupplierBarcode(args: { supplierProductId: string; supplierVariantId: string; variantBarcode?: string | null }): Promise<{ barcode: string; variant: Awaited<ReturnType<typeof fetchCJVariantByVid>> }> {
  // One exact-variant lookup returns barcode, SKU and price together. Reuse
  // this response for supply repair rather than burning a second CJ API call.
  try {
    const variant = await fetchCJVariantByVid(args.supplierVariantId);
    if (variant?.vid === args.supplierVariantId && /^\d{10,25}$/.test(String(variant.productId ?? ""))) {
      return { barcode: normalizeBarcode(variant.barcode), variant };
    }
  } catch (error) { console.warn("[cj-supply-identity] queryByVid barcode lookup failed", { error: error instanceof Error ? error.message : String(error) }); }
  // Product-wide lookup is a fallback only when the exact variant endpoint
  // fails or returns a different product/variant.
  try {
    const variants = await fetchCJProductVariants(args.supplierProductId, { countryCode: "JP" });
    const variant = variants.find((item) => item.vid === args.supplierVariantId && item.productId === args.supplierProductId) ?? null;
    return { barcode: normalizeBarcode(variant?.barcode), variant: null };
  } catch (error) { console.warn("[cj-supply-identity] variant barcode lookup failed", { supplierProductId: args.supplierProductId, error: error instanceof Error ? error.message : String(error) }); }
  return { barcode: "", variant: null };
}

async function resolveMarketplaceIdentityFromBarcode(args: { db: ReturnType<typeof createSupabaseAdminClient>; supplierProductId: string; supplierVariantId: string }, freshBarcode: string): Promise<MarketplaceIdentity | null> {
  // Callers must supply only the result of readSupplierBarcode from this same request.
  // This keeps live evidence fresh without making a second quota-consuming CJ API lookup.
  const barcode = normalizeBarcode(freshBarcode);
  const barcodeIds = identifiersFromRecord({ gtin: barcode, jan: barcode, ean: barcode, upc: barcode });
  const validBarcode = pickSupplierBarcodeIdentifier(barcodeIds);
  if (!validBarcode) return null;

  const lookupValues = [...new Set(marketplaceBarcodeCandidates(validBarcode))];
  const evidenceById = new Map<string, Record<string, unknown>>();
  for (const value of lookupValues) {
    const clauses = ["jan", "gtin", "ean", "upc"].map((column) => `${column}.eq.${value}`);
    const { data, error } = await args.db
      .from("marketplace_bestseller_variants")
      .select("id,bestseller_id,source_variant_id,jan,gtin,ean,upc,evidence_source,raw_evidence,title,product_url,sku")
      .or(clauses.join(","))
      .limit(51);
    if (error) throw new Error(`CJ canonical child-variant identity lookup failed: ${error.message}`);
    if ((data?.length ?? 0) > 50) return null;
    for (const row of data ?? []) {
      // Accept explicit Schema.org children or a child ASIN whose own detail
      // page returned its own valid barcode. Never inherit the parent barcode.
      const rawEvidence = row.raw_evidence && typeof row.raw_evidence === "object" && !Array.isArray(row.raw_evidence)
        ? row.raw_evidence as Record<string, unknown>
        : {};
      const schemaChild = ["schema_org_product_group_has_variant", "schema_org_product_is_variant_of"].includes(String(row.evidence_source));
      const verifiedAmazonChild = row.evidence_source === "amazon_variation_asin_map"
        && rawEvidence.extraction === "child_detail_page"
        && typeof rawEvidence.child_product_url === "string"
        && rawEvidence.child_product_url.startsWith("https://www.amazon.co.jp/dp/")
        && typeof row.source_variant_id === "string"
        && /^[A-Z0-9]{10}$/i.test(row.source_variant_id);
      if (!schemaChild && !verifiedAmazonChild) continue;
      if (typeof row.source_variant_id !== "string" || !row.source_variant_id.trim()) continue;
      const rowIds = identifiersFromRecord(row as Record<string, unknown>);
      const identity = matchProductIdentity({
        market: rowIds,
        supply: { asin: null, mpn: null, gtin: validBarcode, jan: validBarcode, ean: validBarcode, upc: validBarcode },
      });
      if (!identity.salesEligible || !["gtin", "jan", "ean", "upc"].includes(identity.method)) continue;
      evidenceById.set(String(row.id), { ...row, method: identity.method, confidence: identity.confidence, rationale: identity.rationale });
    }
  }

  // If explicit child-variant evidence is unavailable, allow a narrowly-scoped
  // fallback only when the LIVE barcode of this exact CJ variant matches one
  // and only one marketplace bestseller's own declared barcode. This is not a
  // title/brand guess and never copies a parent barcode to a child. The unique
  // marketplace row must already point to a canonical product.
  if (evidenceById.size === 0) {
    const directMatches = new Map<string, Record<string, unknown>>();
    for (const value of lookupValues) {
      const clauses = ["jan", "gtin", "ean", "upc"].map((column) => `${column}.eq.${value}`);
      const { data, error } = await args.db
        .from("marketplace_bestsellers")
        .select("id,product_id,source_item_key,asin,jan,gtin,ean,upc")
        .or(clauses.join(","))
        .limit(51);
      if (error) throw new Error(`CJ exact-barcode marketplace lookup failed: ${error.message}`);
      if ((data?.length ?? 0) > 50) return null;
      for (const row of data ?? []) {
        const rowIds = identifiersFromRecord(row as Record<string, unknown>);
        const identity = matchProductIdentity({
          market: rowIds,
          supply: { asin: null, mpn: null, gtin: validBarcode, jan: validBarcode, ean: validBarcode, upc: validBarcode },
        });
        if (!identity.salesEligible || !["gtin", "jan", "ean", "upc"].includes(identity.method)) continue;
        if (typeof row.product_id !== "string" || !row.product_id.trim()) continue;
        directMatches.set(String(row.id), {
          ...row,
          method: identity.method,
          confidence: identity.confidence,
          rationale: `Unique exact barcode match against marketplace product identifiers; ${identity.rationale}`,
        });
      }
    }
    // Any ambiguity means no link. Do not pick the first matching product.
    if (directMatches.size === 1) {
      const direct = [...directMatches.values()][0];
      return {
        bestsellerId: String(direct.id),
        productId: String(direct.product_id),
        canonicalVariantEvidenceId: `marketplace_bestsellers:${String(direct.id)}`,
        sourceVariantId: String(direct.asin ?? direct.source_item_key ?? direct.id),
        method: direct.method as MarketplaceIdentity["method"],
        confidence: Number(direct.confidence),
        rationale: String(direct.rationale),
      };
    }
  }

  // Both child-evidence uniqueness and canonical-parent uniqueness are required.
  if (evidenceById.size !== 1) return null;
  const evidence = [...evidenceById.values()][0];
  const bestsellerId = String(evidence.bestseller_id ?? "");
  if (!bestsellerId) return null;
  const { data: parent, error: parentError } = await args.db
    .from("marketplace_bestsellers")
    .select("id,product_id")
    .eq("id", bestsellerId)
    .maybeSingle();
  if (parentError) throw new Error(`CJ canonical parent lookup failed: ${parentError.message}`);
  if (!parent || typeof parent.product_id !== "string" || !parent.product_id.trim()) return null;

  return {
    bestsellerId,
    productId: parent.product_id,
    canonicalVariantEvidenceId: String(evidence.id),
    sourceVariantId: String(evidence.source_variant_id),
    method: evidence.method as MarketplaceIdentity["method"],
    confidence: Number(evidence.confidence),
    rationale: String(evidence.rationale),
  };
}

export async function resolveMarketplaceIdentityWithFreshBarcode(args: { db: ReturnType<typeof createSupabaseAdminClient>; supplierProductId: string; supplierVariantId: string; variantBarcode?: string | null; supplierIdentifiers?: { gtin?: string | null; jan?: string | null; ean?: string | null; upc?: string | null; mpn?: string | null } | null }): Promise<{ identity: MarketplaceIdentity | null; variantBarcode: string | null; variantDetails: Awaited<ReturnType<typeof fetchCJVariantByVid>> }> {
  // Fetch the exact CJ variant barcode once, then reuse that same fresh value
  // for both marketplace matching and persistence/diagnostics.
  const freshEvidence = await readSupplierBarcode(args);
  const identity = await resolveMarketplaceIdentityFromBarcode(args, freshEvidence.barcode);
  return { identity, variantBarcode: freshEvidence.barcode || null, variantDetails: freshEvidence.variant };
}

export async function resolveMarketplaceIdentity(args: { db: ReturnType<typeof createSupabaseAdminClient>; supplierProductId: string; supplierVariantId: string; variantBarcode?: string | null; supplierIdentifiers?: { gtin?: string | null; jan?: string | null; ean?: string | null; upc?: string | null; mpn?: string | null } | null }): Promise<MarketplaceIdentity | null> {
  const result = await resolveMarketplaceIdentityWithFreshBarcode(args);
  return result.identity;
}

export async function persistCjSupplyIntelligence(args: PersistCjSupplyIntelligenceArgs): Promise<{ offerId: string | null; intelligenceId: string | null; identity: MarketplaceIdentity | null }> {
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const currencyAssessment = assessCurrencyConfidence({ currency: "USD", price: args.cost, provider: "cj" });
  // CJ is the source of truth for supplier product/variant identity. Do not
  // query Amazon/Rakuten/Yahoo-derived marketplace tables to decide whether a
  // CJ variant can be retained as a supplier offer. The exact live CJ variant
  // barcode supplied by discovery is optional metadata, never a cross-market gate.
  const freshVariantBarcode = args.variantBarcode?.trim() || null;
  let existingListingMetadata: Record<string, unknown> = {};
  const existingListing = await supabase.from("supplier_listings").select("metadata,product_id,verification_status,shipping_status,configured,price_confirmed,inventory_confirmed,api_available,orderable,tracking_available,inventory,cost,shipping_cost,ship_to,supplier_product_id,supplier_variant_id,verification_error,last_verified_at").eq("id", args.supplierListingId).maybeSingle();
  if (existingListing.error) throw new Error(`CJ supplier listing read failed: ${existingListing.error.message}`);
  if (existingListing.data?.metadata && typeof existingListing.data.metadata === "object" && !Array.isArray(existingListing.data.metadata)) existingListingMetadata = existingListing.data.metadata as Record<string, unknown>;
  // Historical TRACER discovery and sales-test paths used two deterministic
  // identity_key encodings for the same exact CJ product+variant. Accept both,
  // but only when they resolve to one unique internal product row.
  const nativeIdentityKeys = [
    `cj:${args.supplierProductId}:${args.supplierVariantId}`,
    `cj:product:${args.supplierProductId}:variant:${args.supplierVariantId}`,
  ];
  let nativeCandidateProductId: string | null = null;
  {
    const exactNativeProducts = await supabase
      .from("products")
      .select("id,identity_key")
      .in("identity_key", nativeIdentityKeys)
      .limit(3);
    if (exactNativeProducts.error) throw new Error(`CJ native product identity lookup failed: ${exactNativeProducts.error.message}`);
    const exactIds = [...new Set((exactNativeProducts.data ?? [])
      .filter((row) => nativeIdentityKeys.includes(String(row.identity_key ?? "")) && String(row.id ?? "").trim())
      .map((row) => String(row.id)))];
    // If the legacy and labelled encodings both exist as different product
    // rows, fail closed instead of silently choosing one.
    if (exactIds.length === 1) nativeCandidateProductId = exactIds[0];
    else if (exactIds.length > 1) {
      console.warn("[cj-supply-identity] duplicate native identity keys; product association withheld", {
        supplierProductId: args.supplierProductId,
        supplierVariantId: args.supplierVariantId,
        candidateCount: exactIds.length,
      });
    }
  }

  const canonicalProductId = nativeCandidateProductId ?? args.productId;
  const priorVerificationError = String(existingListing.data?.verification_error ?? "").trim();
  const priorVerifiedAt = typeof existingListing.data?.last_verified_at === "string" ? Date.parse(existingListing.data.last_verified_at) : NaN;
  // This function is called only after the caller has fetched the exact live
  // CJ variant, current stock, and a Japan freight quote in the same request.
  // Do not require the prior verification_status/timestamp to already be valid:
  // that created a circular gate where a fresh live check could never promote an
  // unverified row. Exact IDs and the freshly persisted capability fields still
  // have to match before the row can be marked verified.
  const nativeEvidenceFresh = existingListing.data?.shipping_status === "verified"
    && existingListing.data?.configured === true
    && existingListing.data?.price_confirmed === true
    && existingListing.data?.inventory_confirmed === true
    && existingListing.data?.api_available === true
    && existingListing.data?.orderable === true
    && existingListing.data?.tracking_available === true
    && String(existingListing.data?.ship_to ?? "").trim().toUpperCase() === "JP"
    && String(existingListing.data?.supplier_product_id ?? "") === args.supplierProductId
    && String(existingListing.data?.supplier_variant_id ?? "") === args.supplierVariantId
    && Number(args.cost) > 0 && Number(args.shippingCost) > 0 && Number(args.inventory) > 0
    && (priorVerificationError === "" || priorVerificationError === "CJdropshipping is not configured" || priorVerificationError === "no_unique_canonical_child_variant_match" || priorVerificationError === "supplier_native_evidence_pending");

  let candidateIntelligenceId: string | null = null;
  if (nativeCandidateProductId) {
    const existingCandidate = await supabase.from("product_intelligence").select("id,normalized_title,brand_name,category,source_url,demand_signal,metadata").eq("product_id", nativeCandidateProductId).maybeSingle();
    if (existingCandidate.error) throw new Error(`CJ native candidate read failed: ${existingCandidate.error.message}`);
    const candidateMetadata = existingCandidate.data?.metadata && typeof existingCandidate.data.metadata === "object" && !Array.isArray(existingCandidate.data.metadata)
      ? existingCandidate.data.metadata as Record<string, unknown>
      : {};
    const candidate = await supabase.from("product_intelligence").upsert({
      product_id: nativeCandidateProductId,
      normalized_title: typeof existingCandidate.data?.normalized_title === "string" && isSpecificJapaneseProductTitle(existingCandidate.data.normalized_title) ? existingCandidate.data.normalized_title : args.title,
      brand_name: existingCandidate.data?.brand_name ?? null,
      category: existingCandidate.data?.category ?? null,
      seller_name: "CJdropshipping",
      source_url: existingCandidate.data?.source_url ?? null,
      image_url: args.imageUrl,
      currency: "USD",
      current_price: args.cost,
      price_confidence: currencyAssessment.confidence === "high" ? 0.9 : currencyAssessment.confidence === "medium" ? 0.6 : 0.2,
      identity_confidence: 0,
      demand_signal: existingCandidate.data?.demand_signal ?? null,
      supply_signal: 1,
      metadata: {
        ...candidateMetadata,
        provider: "cj",
        source: "cj_supply_first",
        catalog_stage: "candidate",
        purchasable: nativeEvidenceFresh,
        identity_status: "supply_discovered",
        identity_method: "supply_discovered",
        supplier_listing_id: args.supplierListingId,
        supplier_product_id: args.supplierProductId,
        supplier_variant_id: args.supplierVariantId,
        variant_barcode: args.variantBarcode ?? null,
        inventory: args.inventory,
        query: args.query,
        fx_rate: args.fxRate,
        selling_price_jpy: args.sellingPriceJpy,
        shipping_cost_usd: args.shippingCost,
        demand_evidence_status: "not_observed",
        identity_rationale: "Supplier-native identity is scoped to the exact CJ product and variant IDs.",
      },
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: "product_id" }).select("id").single();
    if (candidate.error) throw new Error(`CJ native candidate intelligence persistence failed: ${candidate.error.message}`);
    candidateIntelligenceId = String(candidate.data.id);
  }

  const verifiedMetadata = { ...existingListingMetadata, source: "cj_supply_first", identity_source: "cj_exact_product_variant_key", identity_rationale: "Supplier-native identity is scoped to the exact CJ product and variant IDs", supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: freshVariantBarcode, canonical_variant_evidence_id: null, canonical_source_variant_id: null };
  const { error: evidenceError } = await supabase.from("supplier_listings").update({
    bestseller_id: null,
    product_id: nativeCandidateProductId,
    identity_method: "supply_discovered",
    identity_status: "supply_discovered",
    identity_confidence: 0,
    cost: args.cost,
    shipping_cost: args.shippingCost,
    shipping_status: Number.isFinite(args.shippingCost) && args.shippingCost > 0
      ? "verified"
      : (existingListing.data?.shipping_status ?? "unknown"),
    ship_to: Number.isFinite(args.shippingCost) && args.shippingCost > 0
      ? "JP"
      : (existingListing.data?.ship_to ?? null),
    inventory: args.inventory,
    price_confirmed: Number.isFinite(args.cost) && args.cost >= 0,
    inventory_confirmed: Number.isFinite(args.inventory) && args.inventory >= 0,
    verification_status: nativeEvidenceFresh ? "verified" : "unverified",
    verification_error: nativeEvidenceFresh ? null : (priorVerificationError && priorVerificationError !== "no_unique_canonical_child_variant_match" ? priorVerificationError : "supplier_native_evidence_pending"),
    last_verified_at: nativeEvidenceFresh ? now : existingListing.data?.last_verified_at ?? null,
    fetched_at: now,
    metadata: verifiedMetadata,
  }).eq("id", args.supplierListingId);
  if (evidenceError) throw new Error(`CJ supplier evidence persistence failed: ${evidenceError.message}`);
  // Persist a CJ-native offer even without marketplace demand data. This is a
  // supplier discovery record only; the separate sales/procurement gates still
  // decide whether the product can be published or ordered.
  const offerPayload = { product_id: canonicalProductId, seller_name: "CJdropshipping", offer_url: null, image_url: args.imageUrl, currency: "USD", price: args.cost, currency_confidence: currencyAssessment.confidence, availability: args.inventory > 0 ? "available" : "unavailable", shipping_price: args.shippingCost, observed_at: now, metadata: { provider: "cj", source: "cj_supply_first", supplier_listing_id: args.supplierListingId, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? null, inventory: args.inventory, query: args.query, fx_rate: args.fxRate, selling_price_jpy: args.sellingPriceJpy, currency_confidence: currencyAssessment.confidence, currency_confidence_reasons: currencyAssessment.reasons, identity_confidence: 0, identity_status: "supply_discovered", identity_method: "supply_discovered", identity_rationale: "CJ supplier product and variant IDs are the source identity", demand_evidence_status: "not_observed" } };
  const existingOffer = await supabase.from("product_offers").select("id").eq("product_id", canonicalProductId).eq("seller_name", "CJdropshipping").order("observed_at", { ascending: false }).limit(1).maybeSingle();
  if (existingOffer.error) throw new Error(existingOffer.error.message);
  let offerId: string;
  if (existingOffer.data?.id) { const updated = await supabase.from("product_offers").update(offerPayload).eq("id", existingOffer.data.id).select("id").single(); if (updated.error) throw new Error(updated.error.message); offerId = String(updated.data.id); }
  else { const inserted = await supabase.from("product_offers").insert(offerPayload).select("id").single(); if (inserted.error) throw new Error(inserted.error.message || "CJ offer insert failed"); offerId = String(inserted.data.id); }
  const existingIntelligence = await supabase.from("product_intelligence").select("normalized_title,brand_name,category,source_url,demand_signal,metadata").eq("product_id", canonicalProductId).maybeSingle();
  if (existingIntelligence.error) throw new Error(existingIntelligence.error.message);
  const existingMetadata = existingIntelligence.data?.metadata && typeof existingIntelligence.data.metadata === "object" ? existingIntelligence.data.metadata as Record<string, unknown> : {};
  const intelligence = await supabase.from("product_intelligence").upsert({ product_id: canonicalProductId, normalized_title: typeof existingIntelligence.data?.normalized_title === "string" && isSpecificJapaneseProductTitle(existingIntelligence.data.normalized_title) ? existingIntelligence.data.normalized_title : args.title, brand_name: existingIntelligence.data?.brand_name ?? null, category: existingIntelligence.data?.category ?? null, seller_name: "CJdropshipping", source_url: existingIntelligence.data?.source_url ?? null, image_url: args.imageUrl, currency: "USD", current_price: args.cost, price_confidence: currencyAssessment.confidence === "high" ? 0.9 : currencyAssessment.confidence === "medium" ? 0.6 : 0.2, identity_confidence: 0, demand_signal: existingIntelligence.data?.demand_signal ?? null, supply_signal: 1, metadata: { ...existingMetadata, provider: "cj", source: "cj_supply_first", supplier_listing_id: args.supplierListingId, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? existingMetadata.variant_barcode ?? null, inventory: args.inventory, query: args.query, fx_rate: args.fxRate, selling_price_jpy: args.sellingPriceJpy, shipping_cost_usd: args.shippingCost, demand_evidence_status: existingMetadata.demand_evidence_status ?? "not_observed", identity_status: "supply_discovered", identity_method: "supply_discovered", identity_confidence: 0, identity_rationale: "CJ supplier product and variant IDs are the source identity", intelligence_source: "cj_supply_discovery" }, last_seen_at: now, updated_at: now }, { onConflict: "product_id" }).select("id").single();
  if (intelligence.error) throw new Error(intelligence.error.message);
  return { offerId, intelligenceId: String(intelligence.data.id), identity: null };
}
