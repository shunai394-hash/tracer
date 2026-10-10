import "server-only";

import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCJProductVariants, fetchCJVariantByVid } from "@/lib/sources/cj";
import { identifiersFromRecord, matchProductIdentity, marketplaceBarcodeCandidates } from "@/lib/market/identifiers";
import { exactVariantBarcodeMethod, hasUniqueCanonicalVariantMatch } from "@/lib/market/variant-barcode-proof";

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

export type MarketplaceIdentity = { bestsellerId: string; productId: string; method: "gtin" | "jan" | "ean" | "upc"; confidence: number; rationale: string; marketplaceVariantEvidenceId?: string; marketplaceSourceVariantId?: string };

function normalizeBarcode(value: unknown): string { return typeof value === "string" ? value.trim().replace(/[^0-9]/g, "") : ""; }


async function readSupplierBarcode(args: { supplierProductId: string; supplierVariantId: string }): Promise<string> {
  // Only a fresh response explicitly keyed to this exact variant can prove the
  // barcode. Never accept persisted metadata/listing-level variantBarcode here.
  try {
    const variants = await fetchCJProductVariants(args.supplierProductId, { countryCode: "JP" });
    const exact = readExactSupplierVariantBarcode(variants, args.supplierVariantId);
    if (exact) return normalizeBarcode(exact);
  } catch (error) {
    console.warn("[cj-supply-identity] variant barcode lookup failed", {
      supplierProductId: args.supplierProductId,
      supplierVariantId: args.supplierVariantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const detailVariant = await fetchCJVariantByVid(args.supplierVariantId);
    if (detailVariant?.vid === args.supplierVariantId) return normalizeBarcode(detailVariant.barcode);
  } catch (error) {
    console.warn("[cj-supply-identity] queryByVid barcode lookup failed", {
      supplierProductId: args.supplierProductId,
      supplierVariantId: args.supplierVariantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return "";
}

export async function resolveMarketplaceIdentity(args: { db: ReturnType<typeof createSupabaseAdminClient>; supplierProductId: string; supplierVariantId: string; variantBarcode?: string | null; supplierIdentifiers?: { gtin?: string | null; jan?: string | null; ean?: string | null; upc?: string | null; mpn?: string | null } | null }): Promise<MarketplaceIdentity | null> {
  const suppliedIds = identifiersFromRecord({ gtin: args.supplierIdentifiers?.gtin, jan: args.supplierIdentifiers?.jan, ean: args.supplierIdentifiers?.ean, upc: args.supplierIdentifiers?.upc, mpn: args.supplierIdentifiers?.mpn });
  // Prefer a fresh barcode read from the exact CJ variant ID. The optional
  // variantBarcode argument is retained for API compatibility but is not trusted
  // as proof because it may be stale or copied from a parent listing.
  const variantBarcode = await readSupplierBarcode(args);
  // Fail closed: listing/product-level barcode fields are not proof for the concrete
  // supplier variant. If the exact CJ variant has no readable barcode, do not link it.
  if (!variantBarcode) return null;
  const supplyIds = identifiersFromRecord({ gtin: variantBarcode, mpn: suppliedIds.mpn });
  if (!supplyIds.gtin) return null;

  // A parent marketplace barcode is not proof of the child variant. Resolve only
  // against independently captured ProductGroup.hasVariant evidence (PR #175).
  // The migration in PR #175 must be applied before this code is deployed.
  const matchesByVariant = new Map<string, MarketplaceIdentity & { fetchedAt: string }>();
  const lookupValues = new Set<string>();
  for (const value of [supplyIds.gtin, supplyIds.jan, supplyIds.ean, supplyIds.upc]) {
    if (value) marketplaceBarcodeCandidates(value).forEach((candidate) => lookupValues.add(candidate));
  }

  for (const value of lookupValues) {
    const clauses = ["jan", "gtin", "ean", "upc"].map((column) => `${column}.eq.${value}`);
    const { data: variants, error: variantError } = await args.db
      .from("marketplace_bestseller_variants")
      .select("id,bestseller_id,source_variant_id,jan,gtin,ean,upc,mpn,title,fetched_at")
      .or(clauses.join(","))
      .limit(51);
    if (variantError) throw new Error(`CJ canonical child-variant lookup failed: ${variantError.message}`);
    if ((variants?.length ?? 0) > 50) return null;
    if (!variants?.length) continue;

    const bestsellerIds = [...new Set(variants.map((row) => String(row.bestseller_id)).filter(Boolean))];
    const { data: bestsellers, error: bestsellerError } = await args.db
      .from("marketplace_bestsellers")
      .select("id,product_id,brand,title")
      .in("id", bestsellerIds);
    if (bestsellerError) throw new Error(`CJ canonical parent lookup failed: ${bestsellerError.message}`);
    const parentById = new Map((bestsellers ?? []).map((row) => [String(row.id), row]));

    for (const variant of variants) {
      const parent = parentById.get(String(variant.bestseller_id));
      if (!parent || typeof parent.product_id !== "string" || !parent.product_id.trim()) continue;
      const marketIds = identifiersFromRecord(variant as Record<string, unknown>);
      const variantBarcodeMethod = exactVariantBarcodeMethod(marketIds, supplyIds);
      if (!variantBarcodeMethod) continue;
      const identity = matchProductIdentity({
        market: { ...marketIds, brand: typeof parent.brand === "string" ? parent.brand : null, title: typeof variant.title === "string" ? variant.title : (typeof parent.title === "string" ? parent.title : null) },
        supply: { ...supplyIds, title: null, brand: null },
      });
      if (!identity.salesEligible) continue;
      const productId = String(parent.product_id);
      const evidenceId = String(variant.id);
      const candidate = {
        bestsellerId: String(variant.bestseller_id),
        productId,
        method: variantBarcodeMethod,
        confidence: Math.min(identity.confidence, 0.98),
        rationale: `exact supplier-variant barcode matches canonical child-variant evidence (${variantBarcodeMethod})`,
        marketplaceVariantEvidenceId: evidenceId,
        marketplaceSourceVariantId: String(variant.source_variant_id),
        fetchedAt: typeof variant.fetched_at === "string" ? variant.fetched_at : "",
      };
      // A repeated lookup may return the same row. Deduplicate only by the
      // evidence-row ID; two distinct child variants with the same barcode
      // remain ambiguous even when they point to the same parent product.
      matchesByVariant.set(evidenceId, candidate);
    }
  }

  const matches = [...matchesByVariant.values()];
  const distinctProductIds = new Set(matches.map((match) => match.productId));
  if (!hasUniqueCanonicalVariantMatch(matches.length, distinctProductIds.size)) return null;
  const match = matches[0];
  return {
    bestsellerId: match.bestsellerId,
    productId: match.productId,
    method: match.method,
    confidence: match.confidence,
    rationale: match.rationale,
    marketplaceVariantEvidenceId: match.marketplaceVariantEvidenceId,
    marketplaceSourceVariantId: match.marketplaceSourceVariantId,
  };
}

export async function persistCjSupplyIntelligence(args: PersistCjSupplyIntelligenceArgs, options: { identity?: MarketplaceIdentity | null } = {}): Promise<{ offerId: string; intelligenceId: string; identity: MarketplaceIdentity | null }> {
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const currencyAssessment = assessCurrencyConfidence({ currency: "USD", price: args.cost, provider: "cj" });
  const marketplaceIdentity = options.identity !== undefined ? options.identity : await resolveMarketplaceIdentity({ db: supabase, supplierProductId: args.supplierProductId, supplierVariantId: args.supplierVariantId, variantBarcode: args.variantBarcode, supplierIdentifiers: args.supplierIdentifiers });
  const canonicalProductId = marketplaceIdentity?.productId ?? args.productId;
  let existingListingMetadata: Record<string, unknown> = {};
  const existingListing = await supabase.from("supplier_listings").select("metadata").eq("id", args.supplierListingId).maybeSingle();
  if (existingListing.error) throw new Error(`CJ supplier listing read failed: ${existingListing.error.message}`);
  if (existingListing.data?.metadata && typeof existingListing.data.metadata === "object" && !Array.isArray(existingListing.data.metadata)) existingListingMetadata = existingListing.data.metadata as Record<string, unknown>;
  const verifiedMetadata = { ...existingListingMetadata, source: "cj_supply_first", identity_source: marketplaceIdentity ? "cj_variant_barcode_to_canonical_child_variant_evidence" : "cj_variant_evidence", identity_rationale: marketplaceIdentity?.rationale ?? "CJ variant/listing identifier evidence persisted; marketplace identity not yet confirmed", marketplace_variant_evidence_id: marketplaceIdentity?.marketplaceVariantEvidenceId ?? null, marketplace_source_variant_id: marketplaceIdentity?.marketplaceSourceVariantId ?? null, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? existingListingMetadata.variant_barcode ?? null };
  // Always overwrite prior identity/readiness state. A failed or ambiguous re-check
  // must not leave a stale "linked" listing sellable from an earlier successful run.
  const { error: evidenceError } = await supabase.from("supplier_listings").update({
    bestseller_id: marketplaceIdentity?.bestsellerId ?? null,
    product_id: marketplaceIdentity ? canonicalProductId : null,
    identity_method: marketplaceIdentity?.method ?? null,
    identity_status: marketplaceIdentity ? "linked" : "unverified",
    identity_confidence: marketplaceIdentity?.confidence ?? 0,
    cost: args.cost,
    shipping_cost: args.shippingCost,
    inventory: args.inventory,
    price_confirmed: Number.isFinite(args.cost) && args.cost >= 0,
    inventory_confirmed: Number.isFinite(args.inventory) && args.inventory >= 0,
    // Inventory observation alone does not prove that this exact variant can be
    // purchased. Keep the listing closed until exact marketplace identity exists.
    orderable: false, // Discovery and identity matching do not prove the supplier purchase API can place an order.
    // Do not fabricate shipping tracking or purchase-API capability from discovery.
    tracking_available: false,
    api_available: false,
    verification_status: marketplaceIdentity ? "verified" : "identity_unverified",
    fetched_at: now,
    metadata: verifiedMetadata,
  }).eq("id", args.supplierListingId);
  if (evidenceError) throw new Error(`CJ supplier evidence persistence failed: ${evidenceError.message}`);
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
