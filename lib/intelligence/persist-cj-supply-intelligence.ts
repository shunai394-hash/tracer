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
};

export type MarketplaceIdentity = {
  bestsellerId: string;
  productId: string;
  method: "gtin" | "jan" | "ean" | "upc";
  confidence: number;
  rationale: string;
};

export async function resolveMarketplaceIdentity(args: {
  db: ReturnType<typeof createSupabaseAdminClient>;
  supplierProductId: string;
  supplierVariantId: string;
}): Promise<MarketplaceIdentity | null> {
  let variants: Awaited<ReturnType<typeof fetchCJProductVariants>> = [];
  try {
    variants = await fetchCJProductVariants(args.supplierProductId, { countryCode: "JP" });
  } catch (error) {
    console.warn("[cj-supply-identity] variant barcode lookup failed", {
      supplierProductId: args.supplierProductId,
      supplierVariantId: args.supplierVariantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  let variant = variants.find((item) => item.vid === args.supplierVariantId) ?? null;

  // CJ can omit the barcode in product/variant/query while queryByVid still
  // exposes the supplier-declared barcode. Recover that field before giving
  // up. Never infer identity from pid, vid, SKU, title, image, or position.
  if (!variant?.barcode) {
    try {
      const detailVariant = await fetchCJVariantByVid(args.supplierVariantId);
      if (detailVariant?.vid === args.supplierVariantId && detailVariant.barcode) {
        variant = { ...(variant ?? detailVariant), ...detailVariant };
      }
    } catch (error) {
      console.warn("[cj-supply-identity] queryByVid barcode lookup failed", {
        supplierProductId: args.supplierProductId,
        supplierVariantId: args.supplierVariantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const barcode = typeof variant?.barcode === "string" ? variant.barcode.trim() : "";
  if (!barcode) return null;

  const supplyIds = identifiersFromRecord({ gtin: barcode });
  if (!supplyIds.gtin && !supplyIds.jan && !supplyIds.ean && !supplyIds.upc) return null;

  const digits = barcode.replace(/\D/g, "");
  if (!digits) return null;
  const variantsToQuery = new Set([digits]);
  if (digits.length === 12 || digits.length === 13) variantsToQuery.add(digits.padStart(14, "0"));
  if (digits.length === 14) variantsToQuery.add(digits.slice(1));

  const clauses = [...variantsToQuery].flatMap((value) =>
    ["jan", "gtin", "ean", "upc"].map((column) => `${column}.eq.${value}`),
  );
  const { data: bestsellers, error } = await args.db
    .from("marketplace_bestsellers")
    .select("id,product_id,asin,jan,gtin,ean,upc,mpn,title,brand")
    .or(clauses.join(","))
    .limit(50);
  if (error) throw new Error(`CJ marketplace identity lookup failed: ${error.message}`);

  const matches = (bestsellers ?? [])
    .filter((row) => typeof row.product_id === "string" && row.product_id.trim())
    .map((row) => {
      const marketIds = identifiersFromRecord(row as Record<string, unknown>);
      const identity = matchProductIdentity({
        market: {
          ...marketIds,
          brand: typeof row.brand === "string" ? row.brand : null,
          title: typeof row.title === "string" ? row.title : null,
        },
        supply: { ...supplyIds, title: null, brand: null },
      });
      return { row, identity };
    })
    .filter((item) => item.identity.salesEligible && ["gtin", "jan", "ean", "upc"].includes(item.identity.method))
    .map((item) => ({
      bestsellerId: String(item.row.id),
      productId: String(item.row.product_id),
      method: item.identity.method as MarketplaceIdentity["method"],
      confidence: item.identity.confidence,
      rationale: item.identity.rationale,
    }));

  // Never choose arbitrarily when a barcode maps to multiple market records.
  if (matches.length !== 1) return null;
  return matches[0];
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

  // A supply refresh must not erase demand/search/market evidence already
  // produced for the canonical market product. Preserve existing intelligence
  // fields and only refresh the supply-side facts here.
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
        // Unconfirmed marketplace identity carries no identity evidence.
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
