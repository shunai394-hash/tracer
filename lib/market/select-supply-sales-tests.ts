import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupplierCapabilities } from "@/lib/procurement/registry";
import { simulateContributionProfit } from "@/lib/intelligence/simulate-profit";

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function slugify(title: string, productId: string): string {
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 54);
  return \`\${base || "tracer-product"}-\${productId.slice(-8)}\`;
}

export type SupplySalesTestResult = {
  published: number;
  publishedListingIds: string[];
  considered: number;
  rejected: Array<{ productId: string; reasons: string[] }>;
};

export async function selectAndPublishSupplySalesTests(
  productIds: string[],
  limit = 3,
): Promise<SupplySalesTestResult> {
  const supabase = createSupabaseAdminClient();
  if (productIds.length === 0 || limit <= 0) {
    return { published: 0, publishedListingIds: [], considered: 0, rejected: [] };
  }

  const uniqueProductIds = Array.from(new Set(productIds));
  const { data: intelligenceRows, error: intelligenceError } = await supabase
    .from("opportunity_intelligence")
    .select("product_id,demand_score,search_fit_score,market_gap_score,competition_score,creative_score,selection_score,overall_confidence,selection_eligible,sellability_state,filter_state,profit_state,recommendation_summary,why_now")
    .in("product_id", uniqueProductIds);
  if (intelligenceError) throw new Error(intelligenceError.message);

  const { data: intelligenceBase, error: intelligenceBaseError } = await supabase
    .from("product_intelligence")
    .select("product_id,normalized_title,image_url,currency,current_price,metadata")
    .in("product_id", uniqueProductIds);
  if (intelligenceBaseError) throw new Error(intelligenceBaseError.message);

  const { data: listings, error: listingError } = await supabase
    .from("supplier_listings")
    .select("*")
    .in("product_id", uniqueProductIds)
    .eq("supplier", "cj")
    .order("updated_at", { ascending: false });
  if (listingError) throw new Error(listingError.message);

  const intelligenceByProduct = new Map((intelligenceRows ?? []).map((row) => [String(row.product_id), row as Record<string, unknown>]));
  const baseByProduct = new Map((intelligenceBase ?? []).map((row) => [String(row.product_id), row as Record<string, unknown>]));
  const listingByProduct = new Map<string, Record<string, unknown>>();
  for (const row of listings ?? []) {
    const key = String(row.product_id);
    if (!listingByProduct.has(key)) listingByProduct.set(key, row as Record<string, unknown>);
  }

  const rejected: Array<{ productId: string; reasons: string[] }> = [];
  const eligible: Array<{ productId: string; listing: Record<string, unknown>; base: Record<string, unknown>; intelligence: Record<string, unknown>; profit: ReturnType<typeof simulateContributionProfit>; quality: number }> = [];

  for (const productId of uniqueProductIds) {
    const reasons: string[] = [];
    const intelligence = intelligenceByProduct.get(productId);
    const base = baseByProduct.get(productId);
    const listing = listingByProduct.get(productId);

    if (!intelligence) reasons.push("opportunity_intelligence_missing");
    if (!base) reasons.push("product_intelligence_missing");
    if (!listing) reasons.push("supplier_listing_missing");
    if (reasons.length > 0) {
      rejected.push({ productId, reasons });
      continue;
    }

    const supplierCapabilities = getSupplierCapabilities(String(listing.supplier ?? ""));
    const required = [
      ["variant", supplierCapabilities.variant],
      ["inventory", supplierCapabilities.inventory],
      ["price", supplierCapabilities.price],
      ["shipping", supplierCapabilities.shipping],
      ["orderCreation", supplierCapabilities.orderCreation],
      ["payment", supplierCapabilities.payment],
      ["liveOrdering", supplierCapabilities.liveOrdering],
    ] as const;
    const missingCapabilities = required.filter(([, supported]) => !supported).map(([name]) => name);
    if (missingCapabilities.length) reasons.push(\`supplier_capability_missing:\${missingCapabilities.join(",")}\`);

    if (listing.tracking_available !== true) reasons.push("tracking_unknown");
    if (listing.api_available !== true) reasons.push("supplier_api_unknown");
    if (listing.orderable !== true) reasons.push("supplier_not_orderable");
    if (listing.inventory_confirmed !== true) reasons.push("inventory_unknown");
    if ((num(listing.inventory) ?? 0) <= 0) reasons.push("inventory_zero");
    if (typeof listing.supplier_product_id !== "string" || !listing.supplier_product_id) reasons.push("supplier_product_unknown");
    if (typeof listing.supplier_variant_id !== "string" || !listing.supplier_variant_id) reasons.push("supplier_variant_unknown");
    if (num(listing.identity_confidence) === null || (num(listing.identity_confidence) ?? 0) < 0.88) reasons.push("identity_confidence_low");

    const metadata = base.metadata && typeof base.metadata === "object" && !Array.isArray(base.metadata) ? base.metadata as Record<string, unknown> : {};
    const sellingPrice = num(metadata.selling_price_jpy);
    if (sellingPrice === null || sellingPrice <= 0) reasons.push("selling_price_unknown");

    const profit = simulateContributionProfit({
      sellingPrice,
      sellingCurrency: "JPY",
      sellingProvider: "tracer_supply",
      sourceCost: num(listing.cost),
      sourceCurrency: typeof listing.currency === "string" ? listing.currency : "USD",
      sourceProvider: "cj",
      internationalShipping: num(listing.shipping_cost),
      domesticShipping: null,
      shippingCurrency: typeof listing.currency === "string" ? listing.currency : "USD",
    });
    if (!profit.calculable) reasons.push(profit.incalculableReason ?? "profit_unknown");
    if (profit.shippingUnknown) reasons.push("shipping_unknown");
    if (profit.contributionProfit !== null && profit.contributionProfit <= 0) reasons.push("profit_not_positive");

    if (intelligence.selection_eligible !== true) reasons.push("intelligence_selection_ineligible");
    if (!["TEST_READY", "SELLABLE"].includes(String(intelligence.sellability_state ?? ""))) reasons.push("sellability_not_ready");
    if (String(intelligence.filter_state ?? "") !== "PASS") reasons.push("intelligence_filter_not_pass");
    if (String(intelligence.profit_state ?? "") !== "PROFIT_OK") reasons.push("intelligence_profit_not_ok");
    if (num(intelligence.demand_score) === null) reasons.push("demand_evidence_missing");
    if (num(intelligence.search_fit_score) === null) reasons.push("search_fit_evidence_missing");
    if (num(intelligence.market_gap_score) === null) reasons.push("market_gap_evidence_missing");
    if (num(intelligence.overall_confidence) === null || (num(intelligence.overall_confidence) ?? 0) < 0.6) reasons.push("intelligence_confidence_low");

    if (reasons.length) {
      rejected.push({ productId, reasons });
      continue;
    }

    const quality =
      (num(intelligence.selection_score) ?? 0) * 0.45 +
      (num(intelligence.demand_score) ?? 0) * 0.2 +
      (num(intelligence.search_fit_score) ?? 0) * 0.1 +
      (num(intelligence.market_gap_score) ?? 0) * 0.1 +
      (num(intelligence.competition_score) ?? 0) * 0.05 +
      (num(intelligence.creative_score) ?? 0) * 0.05 +
      (num(intelligence.overall_confidence) ?? 0) * 100 * 0.05;

    eligible.push({ productId, listing, base, intelligence, profit, quality });
  }

  eligible.sort((a, b) => b.quality - a.quality);
  const chosen = eligible.slice(0, limit);
  const publishedListingIds: string[] = [];

  for (const item of chosen) {
    const title = String(item.base.normalized_title ?? \`TRACER product \${item.productId}\`);
    const slug = slugify(title, item.productId);
    const now = new Date().toISOString();
    const metadata = item.base.metadata && typeof item.base.metadata === "object" && !Array.isArray(item.base.metadata)
      ? item.base.metadata as Record<string, unknown>
      : {};
    const payload = {
      product_id: item.productId,
      bestseller_id: null,
      supplier_listing_id: item.listing.id,
      slug,
      title,
      description: "TRACERの供給・需要・利益・公開条件を通過した商品です。",
      image_url: item.base.image_url,
      selling_price: num(metadata.selling_price_jpy),
      currency: "JPY",
      supplier_name: "cj",
      supplier_product_id: item.listing.supplier_product_id,
      supplier_variant_id: item.listing.supplier_variant_id,
      source_cost: item.profit.sourceCost,
      shipping_cost: item.profit.internationalShipping,
      inventory: num(item.listing.inventory),
      orderable: item.listing.orderable === true,
      tracking_available: item.listing.tracking_available === true,
      identity_method: item.listing.identity_method ?? "supply_discovered",
      identity_confidence: num(item.listing.identity_confidence),
      contribution_profit: item.profit.contributionProfit,
      contribution_margin: item.profit.contributionMargin,
      published: true,
      selection_reasons: ["supply_intelligence_gate_passed", \`selection_score_\${num(item.intelligence.selection_score)?.toFixed(1) ?? "0"}\`],
      missing: [],
      published_at: now,
      pipeline_stage: "PUBLISHED",
      pipeline_status: "published",
      pipeline_reason: "supply_sales_test_gate_passed",
      pipeline_updated_at: now,
      updated_at: now,
    };

    const existing = await supabase.from("shop_listings").select("id").eq("slug", slug).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    const result = existing.data?.id
      ? await supabase.from("shop_listings").update(payload).eq("id", existing.data.id).select("id").single()
      : await supabase.from("shop_listings").insert(payload).select("id").single();
    if (result.error) throw new Error(result.error.message);
    if (result.data?.id) publishedListingIds.push(String(result.data.id));
  }

  return {
    published: publishedListingIds.length,
    publishedListingIds,
    considered: uniqueProductIds.length,
    rejected: rejected.slice(0, 50),
  };
}
