import "server-only";

import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCJProductVariants, fetchCJVariantByVid } from "@/lib/sources/cj";
import { identifiersFromRecord, matchProductIdentity, marketplaceBarcodeCandidates, pickSupplierBarcodeIdentifier } from "@/lib/market/identifiers";

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

export type MarketplaceIdentity = { bestsellerId: string; productId: string; canonicalVariantEvidenceId: string; canonicalVariantSourceId: string; method: "gtin" | "jan" | "ean" | "upc"; confidence: number; rationale: string };

function normalizeBarcode(value: unknown): string { return typeof value === "string" ? value.trim().replace(/[^0-9]/g, "") : ""; }

async function readSupplierBarcode(args: { supplierProductId: string; supplierVariantId: string; variantBarcode?: string | null }): Promise<string> {
  const supplied = normalizeBarcode(args.variantBarcode);
  if (supplied) return supplied;
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
  const suppliedIds = identifiersFromRecord({
    gtin: args.supplierIdentifiers?.gtin,
    jan: args.supplierIdentifiers?.jan,
    ean: args.supplierIdentifiers?.ean,
    upc: args.supplierIdentifiers?.upc,
    mpn: args.supplierIdentifiers?.mpn,
  });

  // Parent product identifiers and MPNs are not proof of a concrete size/color/pack.
  // Always resolve the supplier's concrete variant barcode, then compare it only
  // with independently stored canonical child-variant evidence.
  const suppliedBarcode = pickSupplierBarcodeIdentifier(suppliedIds);
  // Prefer the live concrete-variant barcode; use a stored valid barcode only if
  // the supplier lookup is unavailable, never the other way around.
  const barcode = (await readSupplierBarcode(args)) || suppliedBarcode || "";
  const supplyIds = identifiersFromRecord({ gtin: barcode || null });
  if (!supplyIds.gtin) return null;

  const lookupValues = new Set(marketplaceBarcodeCandidates(supplyIds.gtin));
  const clauses = ["jan", "gtin", "ean", "upc"]
    .flatMap((column) => [...lookupValues].map((value) => `${column}.eq.${value}`));
  const { data: canonicalRows, error: canonicalError } = await args.db
    .from("marketplace_bestseller_variants")
    .select("id,bestseller_id,source_variant_id,jan,gtin,ean,upc,evidence_source")
    .or(clauses.join(","))
    .limit(51);
  if (canonicalError) throw new Error(`CJ canonical child-variant identity lookup failed: ${canonicalError.message}`);
  if ((canonicalRows?.length ?? 0) > 50) return null;

  const matches = (canonicalRows ?? []).map((row) => {
    const marketIds = identifiersFromRecord(row as Record<string, unknown>);
    const identity = matchProductIdentity({ market: marketIds, supply: supplyIds });
    return { row, identity };
  }).filter((item) =>
    item.identity.salesEligible
    && ["jan", "gtin", "ean", "upc"].includes(item.identity.method)
    && item.row.evidence_source === "schema_org_product_group_has_variant"
    && typeof item.row.id === "string"
    && typeof item.row.bestseller_id === "string"
    && typeof item.row.source_variant_id === "string"
    && item.row.source_variant_id.trim().length > 0,
  );

  // A barcode must resolve to exactly one canonical child variant globally.
  // Multiple matching variants—even under one parent—are ambiguous and remain
  // unlinked until better source evidence arrives.
  if (matches.length !== 1) return null;
  const selected = matches[0];
  const { data: parent, error: parentError } = await args.db
    .from("marketplace_bestsellers")
    .select("id,product_id")
    .eq("id", String(selected.row.bestseller_id))
    .maybeSingle();
  if (parentError) throw new Error(`CJ canonical parent lookup failed: ${parentError.message}`);
  if (!parent || typeof parent.product_id !== "string" || !parent.product_id.trim()) return null;

  return {
    bestsellerId: String(parent.id),
    productId: String(parent.product_id),
    canonicalVariantEvidenceId: String(selected.row.id),
    canonicalVariantSourceId: String(selected.row.source_variant_id),
    method: selected.identity.method as MarketplaceIdentity["method"],
    confidence: selected.identity.confidence,
    rationale: `Unique canonical child variant ${String(selected.row.source_variant_id)} verified by ${selected.identity.method}: ${selected.identity.rationale}`,
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
  const verifiedMetadata = { ...existingListingMetadata, source: "cj_supply_first", identity_source: marketplaceIdentity ? "cj_variant_barcode_to_canonical_child_variant_evidence" : "cj_variant_evidence", identity_rationale: marketplaceIdentity?.rationale ?? "CJ variant/listing identifier evidence persisted; canonical child-variant identity not confirmed", canonical_variant_evidence_id: marketplaceIdentity?.canonicalVariantEvidenceId ?? null, canonical_variant_source_id: marketplaceIdentity?.canonicalVariantSourceId ?? null, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? existingListingMetadata.variant_barcode ?? null };
  const { error: evidenceError } = await supabase.from("supplier_listings").update({ bestseller_id: marketplaceIdentity?.bestsellerId ?? null, product_id: canonicalProductId, identity_method: marketplaceIdentity?.method ?? "supply_discovered", identity_status: marketplaceIdentity ? "linked" : "supply_discovered", identity_confidence: marketplaceIdentity?.confidence ?? 0, cost: args.cost, shipping_cost: args.shippingCost, inventory: args.inventory, price_confirmed: Number.isFinite(args.cost) && args.cost >= 0, inventory_confirmed: Number.isFinite(args.inventory) && args.inventory >= 0, orderable: args.inventory > 0, tracking_available: true, api_available: true, verification_status: "verified", fetched_at: now, metadata: verifiedMetadata }).eq("id", args.supplierListingId);
  if (evidenceError) throw new Error(`CJ supplier evidence persistence failed: ${evidenceError.message}`);
  const offerPayload = { product_id: canonicalProductId, seller_name: "CJdropshipping", offer_url: null, image_url: args.imageUrl, currency: "USD", price: args.cost, currency_confidence: currencyAssessment.confidence, availability: args.inventory > 0 ? "available" : "unavailable", shipping_price: args.shippingCost, observed_at: now, metadata: { provider: "cj", source: "cj_supply_first", supplier_listing_id: args.supplierListingId, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? null, inventory: args.inventory, query: args.query, fx_rate: args.fxRate, selling_price_jpy: args.sellingPriceJpy, currency_confidence: currencyAssessment.confidence, currency_confidence_reasons: currencyAssessment.reasons, identity_confidence: marketplaceIdentity?.confidence ?? 0, identity_status: marketplaceIdentity ? "linked" : "supply_discovered", identity_method: marketplaceIdentity?.method ?? "supply_discovered", identity_rationale: marketplaceIdentity?.rationale ?? "CJ supply discovered; marketplace identity not confirmed", canonical_variant_evidence_id: marketplaceIdentity?.canonicalVariantEvidenceId ?? null, canonical_variant_source_id: marketplaceIdentity?.canonicalVariantSourceId ?? null, demand_evidence_status: "not_observed" } };
  const existingOffer = await supabase.from("product_offers").select("id").eq("product_id", canonicalProductId).eq("seller_name", "CJdropshipping").order("observed_at", { ascending: false }).limit(1).maybeSingle();
  if (existingOffer.error) throw new Error(existingOffer.error.message);
  let offerId: string;
  if (existingOffer.data?.id) { const updated = await supabase.from("product_offers").update(offerPayload).eq("id", existingOffer.data.id).select("id").single(); if (updated.error) throw new Error(updated.error.message); offerId = String(updated.data.id); }
  else { const inserted = await supabase.from("product_offers").insert(offerPayload).select("id").single(); if (inserted.error) throw new Error(inserted.error.message || "CJ offer insert failed"); offerId = String(inserted.data.id); }
  const existingIntelligence = await supabase.from("product_intelligence").select("normalized_title,brand_name,category,source_url,demand_signal,metadata").eq("product_id", canonicalProductId).maybeSingle();
  if (existingIntelligence.error) throw new Error(existingIntelligence.error.message);
  const existingMetadata = existingIntelligence.data?.metadata && typeof existingIntelligence.data.metadata === "object" ? existingIntelligence.data.metadata as Record<string, unknown> : {};
  const intelligence = await supabase.from("product_intelligence").upsert({ product_id: canonicalProductId, normalized_title: existingIntelligence.data?.normalized_title ?? args.title, brand_name: existingIntelligence.data?.brand_name ?? null, category: existingIntelligence.data?.category ?? null, seller_name: "CJdropshipping", source_url: existingIntelligence.data?.source_url ?? null, image_url: args.imageUrl, currency: "USD", current_price: args.cost, price_confidence: currencyAssessment.confidence === "high" ? 0.9 : currencyAssessment.confidence === "medium" ? 0.6 : 0.2, identity_confidence: marketplaceIdentity?.confidence ?? 0, demand_signal: existingIntelligence.data?.demand_signal ?? null, supply_signal: 1, metadata: { ...existingMetadata, provider: "cj", source: "cj_supply_first", supplier_listing_id: args.supplierListingId, supplier_product_id: args.supplierProductId, supplier_variant_id: args.supplierVariantId, variant_barcode: args.variantBarcode ?? existingMetadata.variant_barcode ?? null, inventory: args.inventory, query: args.query, fx_rate: args.fxRate, selling_price_jpy: args.sellingPriceJpy, shipping_cost_usd: args.shippingCost, demand_evidence_status: existingMetadata.demand_evidence_status ?? "not_observed", identity_status: marketplaceIdentity ? "linked" : "supply_discovered", identity_method: marketplaceIdentity?.method ?? "supply_discovered", identity_confidence: marketplaceIdentity?.confidence ?? 0, identity_rationale: marketplaceIdentity?.rationale ?? "CJ supply discovered; marketplace identity not confirmed", canonical_variant_evidence_id: marketplaceIdentity?.canonicalVariantEvidenceId ?? null, canonical_variant_source_id: marketplaceIdentity?.canonicalVariantSourceId ?? null, intelligence_source: "cj_supply_discovery" }, last_seen_at: now, updated_at: now }, { onConflict: "product_id" }).select("id").single();
  if (intelligence.error) throw new Error(intelligence.error.message);
  return { offerId, intelligenceId: String(intelligence.data.id), identity: marketplaceIdentity };
}
