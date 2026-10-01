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

type MarketplaceIdentity = {
  bestsellerId: string;
  productId: string;
  method: "gtin" | "jan" | "ean" | "upc";
  confidence: number;
  rationale: string;
};

async function resolveMarketplaceIdentity(args: {
  db: ReturnType<typeof createSupabaseAdminClient>;
  supplierProductId: string;
  supplierVariantId: string;
}): Promise<MarketplaceIdentity | null> {
  let variants: Awaited<ReturnType<typeof fetchCJProductVariants>> = [];
  try {
    variants = await fetchCJProductVariants(args.supplierProductId);
  } catch (error) {
    console.warn("[cj-supply-identity] variant lookup failed", {
      supplierProductId: args.supplierProductId,
      supplierVariantId: args.supplierVariantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  let variant = variants.find((item) => item.vid === args.supplierVariantId) ?? null;

  if (!variant?.barcode) {
    try {
      const detail = await fetchCJVariantByVid(args.supplierVariantId);
      if (detail?.vid === args.supplierVariantId && detail.barcode) {
        variant = { ...(variant ?? detail), ...detail };
      }
    } catch (error) {
      console.warn("[cj-supply-identity] queryByVid barcode lookup failed", {
        supplierProductId: args.supplierProductId,
        supplierVariantId: args.supplierVariantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const barcode = variant?.barcode?.trim() ?? "";
  if (!barcode) return null;

  const supplyIds = identifiersFromRecord({ gtin: barcode });
  if (!supplyIds.gtin && !supplyIds.jan && !supplyIds.ean && !supplyIds.upc) return null;

  const digits = barcode.replace(/\D/g, "");
  if (!digits) return null;

  const forms = new Set<string>([digits]);
  if (digits.length === 12 || digits.length === 13) forms.add(digits.padStart(14, "0"));
  if (digits.length === 14) forms.add(digits.slice(1));

  const clauses = [...forms].flatMap((value) =>
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
    .filter((item) =>
      item.identity.salesEligible &&
      ["gtin", "jan", "ean", "upc"].includes(item.identity.method),
    )
    .map((item) => ({
      bestsellerId: String(item.row.id),
      productId: String(item.row.product_id),
      method: item.identity.method as MarketplaceIdentity["method"],
      confidence: item.identity.confidence,
      rationale: item.identity.rationale,
    }));

  return matches.length === 1 ? matches[0] : null;
}

export async function persistCjSupplyIntelligence(
  args: PersistCjSupplyIntelligenceArgs,
): Promise<{ offerId: string; intelligenceId: string }> {
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const currencyAssessment = assessCurrencyConfidence({
    currency: "USD",
    price: args.cost,
    provider: "cj",
  });

  const marketplaceIdentity = await resolveMarketplaceIdentity({
    db: supabase,
    supplierProductId: args.supplierProductId,
    supplierVariantId: args.supplierVariantId,
  });

  if (marketplaceIdentity) {
    const { error } = await supabase
      .from("supplier_listings")
      .update({
        bestseller_id: marketplaceIdentity.bestsellerId,
        product_id: marketplaceIdentity.productId,
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
    product_id: marketplaceIdentity?.productId ?? args.productId,
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
      identity_confidence: marketplaceIdentity?.confidence ?? 1,
      identity_status: marketplaceIdentity ? "linked" : "supply_discovered",
      identity_method: marketplaceIdentity?.method ?? "supply_discovered",
      identity_rationale: marketplaceIdentity?.rationale ?? "CJ supply discovered; marketplace identity not confirmed",
      demand_evidence_status: "not_observed",
    },
  };

  const existingOffer = await supabase
    .from("product_offers")
    .select("id")
    .eq("product_id", marketplaceIdentity?.productId ?? args.productId)
    .eq("seller_name", "CJdropshipping")
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingOffer.error) throw new Error(existingOffer.error.message);

  let offerId: string;
  if (existingOffer.data?.id) {
    const updated = await supabase
      .from("product_offers")
      .update(offerPayload)
      .eq("id", existingOffer.data.id)
      .select("id")
      .single();
    if (updated.error) throw new Error(updated.error.message);
    offerId = String(updated.data.id);
  } else {
    const inserted = await supabase
      .from("product_offers")
      .insert(offerPayload)
      .select("id")
      .single();
    if (inserted.error) throw new Error(inserted.error.message);
    offerId = String(inserted.data.id);
  }

  const intelligence = await supabase
    .from("product_intelligence")
    .upsert(
      {
        product_id: marketplaceIdentity?.productId ?? args.productId,
        normalized_title: args.title,
        brand_name: null,
        category: null,
        seller_name: "CJdropshipping",
        source_url: null,
        image_url: args.imageUrl,
        currency: "USD",
        current_price: args.cost,
        price_confidence:
          currencyAssessment.confidence === "high"
            ? 0.9
            : currencyAssessment.confidence === "medium"
              ? 0.6
              : 0.2,
        identity_confidence: marketplaceIdentity?.confidence ?? 1,
        demand_signal: null,
        supply_signal: 1,
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
          shipping_cost_usd: args.shippingCost,
          demand_evidence_status: "not_observed",
          identity_status: marketplaceIdentity ? "linked" : "supply_discovered",
          identity_method: marketplaceIdentity?.method ?? "supply_discovered",
          identity_confidence: marketplaceIdentity?.confidence ?? 1,
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

  return {
    offerId,
    intelligenceId: String(intelligence.data.id),
  };
}
