import "server-only";

import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCJProductVariants, fetchCJVariantByVid } from "@/lib/sources/cj";
import { identifiersFromRecord, matchProductIdentity } from "@/lib/market/identifiers";

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
  /** Supplier-declared variant barcode captured during discovery. */
  variantBarcode?: string | null;
};

export type MarketplaceIdentity = {
  bestsellerId: string;
  productId: string;
  method: "gtin" | "jan" | "ean" | "upc";
  confidence: number;
  rationale: string;
};

function normalizeBarcode(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/[^0-9]/g, "") : "";
}

function barcodeCandidates(value: string): string[] {
  const digits = normalizeBarcode(value);
  if (!digits) return [];
  const candidates = new Set<string>([digits]);
  if (digits.length === 12 || digits.length === 13) candidates.add(digits.padStart(14, "0"));
  if (digits.length === 14) candidates.add(digits.slice(1));
  return [...candidates];
}

async function readSupplierBarcode(args: {
  supplierProductId: string;
  supplierVariantId: string;
  variantBarcode?: string | null;
}): Promise<string> {
  const supplied = normalizeBarcode(args.variantBarcode);
  if (supplied) return supplied;
  try {
    const variants = await fetchCJProductVariants(args.supplierProductId, { countryCode: "JP" });
    const variant = variants.find((item) => item.vid === args.supplierVariantId);
    const direct = normalizeBarcode(variant?.barcode);
    if (direct) return direct;
  } catch (error) {
    console.warn("[cj-supply-identity] variant barcode lookup failed", { supplierProductId: args.supplierProductId, supplierVariantId: args.supplierVariantId, error: error instanceof Error ? error.message : String(error) });
  }
  try {
    const detailVariant = await fetchCJVariantByVid(args.supplierVariantId);
    if (detailVariant?.vid === args.supplierVariantId) return normalizeBarcode(detailVariant.barcode);
  } catch (error) {
    console.warn("[cj-supply-identity] queryByVid barcode lookup failed", { supplierProductId: args.supplierProductId, supplierVariantId: args.supplierVariantId, error: error instanceof Error ? error.message : String(error) });
  }
  return "";
}

export async function resolveMarketplaceIdentity(args: {
  db: ReturnType<typeof createSupabaseAdminClient>;
  supplierProductId: string;
  supplierVariantId: string;
  variantBarcode?: string | null;
}): Promise<MarketplaceIdentity | null> {
  const barcode = await readSupplierBarcode(args);
  if (!barcode) return null;
  const supplyIds = identifiersFromRecord({ gtin: barcode });
  if (!supplyIds.gtin && !supplyIds.jan && !supplyIds.ean && !supplyIds.upc) return null;
  // A marketplace snapshot can contain many rows for the same canonical product.
  // Identity cardinality must therefore be measured by canonical product_id, not snapshot row id.
  const matchesByProduct = new Map<string, MarketplaceIdentity & { fetchedAt: string }>();
  for (const value of barcodeCandidates(barcode)) {
    const clauses = ["jan", "gtin", "ean", "upc"].map((column) => `${column}.eq.${value}`);
    // Fetch one beyond the processing cap so a truncated result can never be mistaken for a unique identity.
    const { data: bestsellers, error } = await args.db.from("marketplace_bestsellers").select("id,product_id,asin,jan,gtin,ean,upc,mpn,title,brand,fetched_at").or(clauses.join(",")).limit(51);
    if (error) throw new Error(`CJ marketplace identity lookup failed: ${error.message}`);
    if ((bestsellers?.length ?? 0) > 50) return null;
    for (const row of bestsellers ?? []) {
      if (typeof row.product_id !== "string" || !row.product_id.trim()) continue;
      const marketIds = identifiersFromRecord(row as Record<string, unknown>);
      const identity = matchProductIdentity({ market: { ...marketIds, brand: typeof row.brand === "string" ? row.brand : null, title: typeof row.title === "string" ? row.title : null }, supply: { ...supplyIds, title: null, brand: null } });
      if (!identity.salesEligible || !["gtin", "jan", "ean", "upc"].includes(identity.method)) continue;
      const productId = String(row.product_id);
      const candidate = {
        bestsellerId: String(row.id),
        productId,
        method: identity.method as MarketplaceIdentity["method"],
        confidence: identity.confidence,
        rationale: identity.rationale,
        fetchedAt: typeof row.fetched_at === "string" ? row.fetched_at : "",
      };
      const current = matchesByProduct.get(productId);
      if (
        !current ||
        candidate.confidence > current.confidence ||
        (candidate.confidence === current.confidence && candidate.fetchedAt > current.fetchedAt)
      ) {
        matchesByProduct.set(productId, candidate);
      }
    }
  }
  if (matchesByProduct.size !== 1) return null;
  const [match] = matchesByProduct.values();
  if (!match) return null;
  return {
    bestsellerId: match.bestsellerId,
    productId: match.productId,
    method: match.method,
    confidence: match.confidence,
    rationale: match.rationale,
  };
}
export async function persistCjSupplyIntelligence(
  args: PersistCjSupplyIntelligenceArgs,
  options: { identity?: MarketplaceIdentity | null } = {},
): Promise<{ offerId: string; intelligenceId: string; identity: MarketplaceIdentity | null }> {
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const currencyAssessment = assessCurrencyConfidence({
    currency: "USD",
    price: args.cost,
    provider: "cj",
  });

  const marketplaceIdentity = options.identity !== undefined
    ? options.identity
    : await resolveMarketplaceIdentity({
        db: supabase,
        supplierProductId: args.supplierProductId,
        supplierVariantId: args.supplierVariantId,
        variantBarcode: args.variantBarcode,
      });
  const canonicalProductId = marketplaceIdentity?.productId ?? args.productId;

  if (marketplaceIdentity) {
    const { error } = await supabase
      .from("supplier_listings")
      .update({
        bestseller_id: marketplaceIdentity.bestsellerId,
        product_id: canonicalProductId,
        identity_method: marketplaceIdentity.method,
        identity_status: "linked",
        identity_confidence: marketplaceIdentity.confidence,
        metadata: {
          source: "cj_supply_first",
          identity_source: "cj_variant_barcode_to_marketplace_bestseller",
          identity_rationale: marketplaceIdentity.rationale,
          supplier_product_id: args.supplierProductId,
          supplier_variant_id: args.supplierVariantId,
          variant_barcode: args.variantBarcode ?? null,
        },
      })
      .eq("id", args.supplierListingId);
    if (error) throw new Error(`CJ supplier identity promotion failed: ${error.message}`);
  }

  const offerPayload = {
    product_id: canonicalProductId,
    seller_name: "CJdropshipping",
    offer_url: null,
    image_url: args.imageUrl,
    currency: "USD",
    price: args.cost,
    currency_confidence: currencyAssessment.confidence,
    availability: args.inventory > 0 ? "available" : "unavailable",
    shipping_price: args.shippingCost,
    observed_at: now,
    metadata: {
      provider: "cj",
      source: "cj_supply_first",
      supplier_listing_id: args.supplierListingId,
      supplier_product_id: args.supplierProductId,
      supplier_variant_id: args.supplierVariantId,
      variant_barcode: args.variantBarcode ?? null,
      inventory: args.inventory,
      query: args.query,
      fx_rate: args.fxRate,
      selling_price_jpy: args.sellingPriceJpy,
      currency_confidence: currencyAssessment.confidence,
      currency_confidence_reasons: currencyAssessment.reasons,
      identity_confidence: marketplaceIdentity?.confidence ?? 0,
      identity_status: marketplaceIdentity ? "linked" : "supply_discovered",
      identity_method: marketplaceIdentity?.method ?? "supply_discovered",
      identity_rationale: marketplaceIdentity?.rationale ?? "CJ supply discovered; marketplace identity not confirmed",
      demand_evidence_status: "not_observed",
    },
  };

  const existingOffer = await supabase
    .from("product_offers")
    .select("id")
    .eq("product_id", canonicalProductId)
    .eq("seller_name", "CJdropshipping")
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingOffer.error) throw new Error(existingOffer.error.message);

  let offerId: string;
  if (existingOffer.data?.id) {
    const updated = await supabase.from("product_offers").update(offerPayload).eq("id", existingOffer.data.id).select("id").single();
    if (updated.error) throw new Error(updated.error.message);
    offerId = String(updated.data.id);
  } else {
    const inserted = await supabase.from("product_offers").insert(offerPayload).select("id").single();
    if (inserted.error) throw new Error(inserted.error.message);
    offerId = String(inserted.data.id);
  }

  const existingIntelligence = await supabase
    .from("product_intelligence")
    .select("normalized_title,brand_name,category,source_url,demand_signal,metadata")
    .eq("product_id", canonicalProductId)
    .maybeSingle();
  if (existingIntelligence.error) throw new Error(existingIntelligence.error.message);

  const existingMetadata = existingIntelligence.data?.metadata && typeof existingIntelligence.data.metadata === "object"
    ? existingIntelligence.data.metadata as Record<string, unknown>
    : {};

  const intelligence = await supabase
    .from("product_intelligence")
    .upsert(
      {
        product_id: canonicalProductId,
        normalized_title: existingIntelligence.data?.normalized_title ?? args.title,
        brand_name: existingIntelligence.data?.brand_name ?? null,
        category: existingIntelligence.data?.category ?? null,
        seller_name: "CJdropshipping",
        source_url: existingIntelligence.data?.source_url ?? null,
        image_url: args.imageUrl,
        currency: "USD",
        current_price: args.cost,
        price_confidence: currencyAssessment.confidence === "high" ? 0.9 : currencyAssessment.confidence === "medium" ? 0.6 : 0.2,
        identity_confidence: marketplaceIdentity?.confidence ?? 0,
        demand_signal: existingIntelligence.data?.demand_signal ?? null,
        supply_signal: 1,
        metadata: {
          ...existingMetadata,
          provider: "cj",
          source: "cj_supply_first",
          supplier_listing_id: args.supplierListingId,
          supplier_product_id: args.supplierProductId,
          supplier_variant_id: args.supplierVariantId,
          variant_barcode: args.variantBarcode ?? null,
          inventory: args.inventory,
          query: args.query,
          fx_rate: args.fxRate,
          selling_price_jpy: args.sellingPriceJpy,
          shipping_cost_usd: args.shippingCost,
          demand_evidence_status: existingMetadata.demand_evidence_status ?? "not_observed",
          identity_status: marketplaceIdentity ? "linked" : "supply_discovered",
          identity_method: marketplaceIdentity?.method ?? "supply_discovered",
          identity_confidence: marketplaceIdentity?.confidence ?? 0,
          identity_rationale: marketplaceIdentity?.rationale ?? "CJ supply discovered; marketplace identity not confirmed",
          intelligence_source: "cj_supply_discovery",
        },
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: "product_id" },
    )
    .select("id")
    .single();

  if (intelligence.error) throw new Error(intelligence.error.message);
  return { offerId, intelligenceId: String(intelligence.data.id), identity: marketplaceIdentity };
}
