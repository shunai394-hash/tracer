import "server-only";

import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

  const offerPayload = {
    product_id: args.productId,
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
      identity_confidence: 1,
      identity_status: "supply_discovered",
      demand_evidence_status: "not_observed",
    },
  };

  const existingOffer = await supabase
    .from("product_offers")
    .select("id")
    .eq("product_id", args.productId)
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
        product_id: args.productId,
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
        identity_confidence: 1,
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
