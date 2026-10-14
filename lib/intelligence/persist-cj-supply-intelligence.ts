import "server-only";

import { randomUUID } from "node:crypto";

import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCJProductVariants, fetchCJVariantByVid } from "@/lib/sources/cj";
import { identifiersFromRecord, matchProductIdentity, marketplaceBarcodeCandidates, pickSupplierBarcodeIdentifier } from "@/lib/market/identifiers";
import { hasUniqueMarketplaceIdentity } from "@/lib/suppliers/cj-identity-reverify-policy";
import { normalizeSupplierLocator } from "@/lib/catalog/supplier-locators";

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

async function readSupplierBarcode(args: { supplierProductId: string; supplierVariantId: string; variantBarcode?: string | null }): Promise<string> {
  // A persisted/listing-level barcode is not proof for this exact variant. Always re-read the live CJ variant.
  try {
    const variants = await fetchCJProductVariants(args.supplierProductId, { countryCode: "JP" });
    const direct = normalizeBarcode(variants.find((item) => item.vid === args.supplierVariantId)?.barcode);
    if (direct) return direct;
  } catch (error) { console.warn("[cj-supply-identity] variant barcode lookup failed", { error: error instanceof Error ? error.message : String(error) }); }
  try {
    const detailVariant = await fetchCJVariantByVid(args.supplierVariantId);
    if (detailVariant?.vid === args.supplierVariantId) return normalizeBarcode(detailVariant.barcode);
  } catch (error) { console.warn("[cj-supply-identity] queryByVid barcode lookup failed", { error: error instanceof Error ? error.message : String(error) }); }
  return "";
}

export async function resolveMarketplaceIdentity(args: { db: ReturnType<typeof createSupabaseAdminClient>; supplierProductId: string; supplierVariantId: string; variantBarcode?: string | null; supplierIdentifiers?: { gtin?: string | null; jan?: string | null; ean?: string | null; upc?: string | null; mpn?: string | null } | null }): Promise<MarketplaceIdentity | null> {
  // Identity must be proven by a fresh barcode returned for this exact supplier variant.
  // Never use parent-product MPN, title, or a caller-supplied stale barcode as a substitute.
  const barcode = normalizeBarcode(await readSupplierBarcode(args));
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
      const schemaChild = row.evidence_source === "schema_org_product_group_has_variant";
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

export async function persistCjSupplyIntelligence(args: PersistCjSupplyIntelligenceArgs, options: { identity?: MarketplaceIdentity | null } = {}): Promise<{ offerId: string | null; intelligenceId: string | null; identity: MarketplaceIdentity | null }> {
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const currencyAssessment = assessCurrencyConfidence({ currency: "USD", price: args.cost, provider: "cj" });
  const marketplaceIdentity = options.identity !== undefined ? options.identity : await resolveMarketplaceIdentity({ db: supabase, supplierProductId: args.supplierProductId, supplierVariantId: args.supplierVariantId, variantBarcode: args.variantBarcode, supplierIdentifiers: args.supplierIdentifiers });
  const canonicalProductId = marketplaceIdentity?.productId ?? args.productId;
  let existingListingMetadata: Record<string, unknown> = {};
  const existingListing = await supabase.from("supplier_listings").select("product_id,metadata").eq("id", args.supplierListingId).maybeSingle();
  if (existingListing.error) throw new Error(`CJ supplier listing read failed: ${existingListing.error.message}`);
  if (existingListing.data?.metadata && typeof existingListing.data.metadata === "object" && !Array.isArray(existingListing.data.metadata)) existingListingMetadata = existingListing.data.metadata as Record<string, unknown>;
  const priorProductId = typeof existingListing.data?.product_id === "string" ? existingListing.data.product_id.trim() : "";
  const priorIdentityStatus = typeof existingListingMetadata.identity_status === "string" ? existingListingMetadata.identity_status : "";
  // Keep one stable candidate ID on the supplier row so retries update the same product
  // instead of dropping the offer or creating a new candidate on every discovery pass.
  const nativeCandidateProductId = !marketplaceIdentity && priorIdentityStatus === "supply_discovered" && priorProductId
    ? priorProductId
    : !marketplaceIdentity ? randomUUID() : marketplaceIdentity.productId;
  const resolvedProductId = marketplaceIdentity?.productId ?? nativeCandidateProductId;
  const supplierLocator = normalizeSupplierLocator({ supplier: "cj", supplierProductId: args.supplierProductId, supplierVariantId: args.supplierVariantId, productUrl: existingListingMetadata.source_ref, sku: existingListingMetadata.supplier_sku, barcode: args.variantBarcode, title: args.title });
  const verifiedMetadata = { ...existingListingMetadata, source: "cj_supply_first", identity_source: marketplaceIdentity ? "fresh_exact_cj_variant_barcode_to_canonical_child_variant" : "supplier_native_locator_unresolved_marketplace_identity", identity_status: marketplaceIdentity ? "linked" : "supply_discovered", identity_rationale: marketplaceIdentity?.rationale ?? "Supplier-native product and variant are retained as a candidate; marketplace identity is not yet confirmed", supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: await readSupplierBarcode({ supplierProductId: args.supplierProductId, supplierVariantId: args.supplierVariantId }), canonical_variant_evidence_id: marketplaceIdentity?.canonicalVariantEvidenceId ?? null, canonical_source_variant_id: marketplaceIdentity?.sourceVariantId ?? null, supplier_locator: { ...supplierLocator, source_ref: existingListingMetadata.source_ref ?? null } };
  const { error: evidenceError } = await supabase.from("supplier_listings").update({ bestseller_id: marketplaceIdentity?.bestsellerId ?? null, product_id: resolvedProductId, identity_method: marketplaceIdentity?.method ?? "supply_discovered", identity_status: marketplaceIdentity ? "linked" : "supply_discovered", identity_confidence: marketplaceIdentity?.confidence ?? 0, cost: args.cost, shipping_cost: args.shippingCost, inventory: args.inventory, price_confirmed: Number.isFinite(args.cost) && args.cost >= 0, inventory_confirmed: Number.isFinite(args.inventory) && args.inventory >= 0, verification_status: marketplaceIdentity ? "verified" : "unverified", verification_error: marketplaceIdentity ? null : "marketplace_identity_unresolved_candidate_retained", last_verified_at: now, fetched_at: now, metadata: verifiedMetadata }).eq("id", args.supplierListingId);
  if (evidenceError) throw new Error(`CJ supplier evidence persistence failed: ${evidenceError.message}`);
  // Missing marketplace barcode identity must not erase a real supplier candidate.
  // Preserve supplier product/variant IDs and economics, but do not mark it purchasable.
  if (!marketplaceIdentity) {
    const { data: existingIntelligence, error: readError } = await supabase.from("product_intelligence").select("normalized_title,brand_name,category,source_url,demand_signal,metadata").eq("product_id", resolvedProductId).maybeSingle();
    if (readError) throw new Error(`CJ candidate intelligence read failed: ${readError.message}`);
    const priorMetadata = existingIntelligence?.metadata && typeof existingIntelligence.metadata === "object" && !Array.isArray(existingIntelligence.metadata) ? existingIntelligence.metadata as Record<string, unknown> : {};
    const candidate = await supabase.from("product_intelligence").upsert({
      product_id: resolvedProductId,
      normalized_title: existingIntelligence?.normalized_title ?? args.title,
      brand_name: existingIntelligence?.brand_name ?? null,
      category: existingIntelligence?.category ?? null,
      seller_name: "CJdropshipping",
      source_url: existingIntelligence?.source_url ?? (typeof existingListingMetadata.source_ref === "string" && /^https?:\\/\\//i.test(existingListingMetadata.source_ref) ? existingListingMetadata.source_ref : null),
      image_url: args.imageUrl,
      currency: "USD",
      current_price: args.cost,
      price_confidence: currencyAssessment.confidence === "high" ? 0.9 : currencyAssessment.confidence === "medium" ? 0.6 : 0.2,
      identity_confidence: 0,
      demand_signal: existingIntelligence?.demand_signal ?? null,
      supply_signal: 1,
      metadata: { ...priorMetadata, provider: "cj", source: "cj_supply_first", catalog_stage: "candidate", purchasable: false, supplier_listing_id: args.supplierListingId, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? null, inventory: args.inventory, query: args.query, fx_rate: args.fxRate, selling_price_jpy: args.sellingPriceJpy, shipping_cost_usd: args.shippingCost, demand_evidence_status: priorMetadata.demand_evidence_status ?? "not_observed", identity_status: "supply_discovered", identity_method: "supply_discovered", identity_confidence: 0, identity_rationale: "Supplier-native candidate retained; marketplace identity and automated-order eligibility remain unverified" },
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: "product_id" }).select("id").single();
    if (candidate.error) throw new Error(`CJ candidate intelligence persistence failed: ${candidate.error.message}`);
    return { offerId: null, intelligenceId: String(candidate.data.id), identity: null };
  }
  const offerPayload = { product_id: canonicalProductId, seller_name: "CJdropshipping", offer_url: null, image_url: args.imageUrl, currency: "USD", price: args.cost, currency_confidence: currencyAssessment.confidence, availability: args.inventory > 0 ? "available" : "unavailable", shipping_price: args.shippingCost, observed_at: now, metadata: { provider: "cj", source: "cj_supply_first", supplier_listing_id: args.supplierListingId, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? null, inventory: args.inventory, query: args.query, fx_rate: args.fxRate, selling_price_jpy: args.sellingPriceJpy, currency_confidence: currencyAssessment.confidence, currency_confidence_reasons: currencyAssessment.reasons, identity_confidence: marketplaceIdentity?.confidence ?? 0, identity_status: marketplaceIdentity ? "linked" : "supply_discovered", identity_method: marketplaceIdentity?.method ?? "supply_discovered", identity_rationale: marketplaceIdentity?.rationale ?? "CJ supply discovered; marketplace identity not confirmed", demand_evidence_status: "not_observed" } };
  const existingOffer = await supabase.from("product_offers").select("id").eq("product_id", canonicalProductId).eq("seller_name", "CJdropshipping").order("observed_at", { ascending: false }).limit(1).maybeSingle();
  if (existingOffer.error) throw new Error(existingOffer.error.message);
  let offerId: string;
  if (existingOffer.data?.id) { const updated = await supabase.from("product_offers").update(offerPayload).eq("id", existingOffer.data.id).select("id").single(); if (updated.error) throw new Error(updated.error.message); offerId = String(updated.data.id); }
  else { const inserted = await supabase.from("product_offers").insert(offerPayload).select("id").single(); if (inserted.error) throw new Error(inserted.error.message || "CJ offer insert failed"); offerId = String(inserted.data.id); }
  const existingIntelligence = await supabase.from("product_intelligence").select("normalized_title,brand_name,category,source_url,demand_signal,metadata").eq("product_id", canonicalProductId).maybeSingle();
  if (existingIntelligence.error) throw new Error(existingIntelligence.error.message);
  const existingMetadata = existingIntelligence.data?.metadata && typeof existingIntelligence.data.metadata === "object" ? existingIntelligence.data.metadata as Record<string, unknown> : {};
  const intelligence = await supabase.from("product_intelligence").upsert({ product_id: canonicalProductId, normalized_title: existingIntelligence.data?.normalized_title ?? args.title, brand_name: existingIntelligence.data?.brand_name ?? null, category: existingIntelligence.data?.category ?? null, seller_name: "CJdropshipping", source_url: existingIntelligence.data?.source_url ?? null, image_url: args.imageUrl, currency: "USD", current_price: args.cost, price_confidence: currencyAssessment.confidence === "high" ? 0.9 : currencyAssessment.confidence === "medium" ? 0.6 : 0.2, identity_confidence: marketplaceIdentity?.confidence ?? 0, demand_signal: existingIntelligence.data?.demand_signal ?? null, supply_signal: 1, metadata: { ...existingMetadata, provider: "cj", source: "cj_supply_first", supplier_listing_id: args.supplierListingId, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? existingMetadata.variant_barcode ?? null, inventory: args.inventory, query: args.query, fx_rate: args.fxRate, selling_price_jpy: args.sellingPriceJpy, shipping_cost_usd: args.shippingCost, demand_evidence_status: existingMetadata.demand_evidence_status ?? "not_observed", identity_status: marketplaceIdentity ? "linked" : "supply_discovered", identity_method: marketplaceIdentity?.method ?? "supply_discovered", identity_confidence: marketplaceIdentity?.confidence ?? 0, identity_rationale: marketplaceIdentity?.rationale ?? "CJ supply discovered; marketplace identity not confirmed", intelligence_source: "cj_supply_discovery" }, last_seen_at: now, updated_at: now }, { onConflict: "product_id" }).select("id").single();
  if (intelligence.error) throw new Error(intelligence.error.message);
  return { offerId, intelligenceId: String(intelligence.data.id), identity: marketplaceIdentity };
}
