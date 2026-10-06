import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { womenProductPriority } from "@/lib/intelligence/womens-priority";
import { simulateContributionProfit } from "@/lib/intelligence/simulate-profit";
import { writeEvidence } from "@/lib/market/evidence-ledger";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";
import { SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { getSupplierCapabilities } from "@/lib/procurement/registry";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function slugify(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "item"}-${id.slice(0, 8)}`;
}

function validHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type SalesTestSelection = {
  published: number;
  publishedListingIds: string[];
  considered: number;
  rejected: Array<{ id: string; reasons: string[] }>;
};

/**
 * Publish at most 3 shop listings. Every gate is observed data.
 * Title-only identity never qualifies.
 */
export async function selectAndPublishSalesTests(
  bestsellerIds: string[],
  limit = 3,
): Promise<SalesTestSelection> {
  const supabase = createSupabaseAdminClient();
  const fetchedAt = new Date().toISOString();
  const fxQuote = await getObservedUsdToJpyRate();

  const { data: bestsellers, error } = bestsellerIds.length === 0
    ? { data: [], error: null }
    : await supabase
        .from("marketplace_bestsellers")
        .select("*")
        .in("id", bestsellerIds);

  if (error) throw new Error(error.message);

  const rejected: Array<{ id: string; reasons: string[] }> = [];

  async function markPipeline(
    bestsellerId: string,
    stage: string,
    status: string,
    reason: string | null,
    error: string | null = null,
  ): Promise<void> {
    const { error: updateError } = await supabase
      .from("marketplace_bestsellers")
      .update({
        pipeline_stage: stage,
        pipeline_status: status,
        pipeline_reason: reason,
        pipeline_error: error,
        pipeline_updated_at: new Date().toISOString(),
      })
      .eq("id", bestsellerId);
    if (updateError) throw new Error(updateError.message);
  }
  const publishedListingIds: string[] = [];
  const eligible: Array<{
    bestseller: Record<string, unknown>;
    listing: Record<string, unknown>;
    profit: ReturnType<typeof simulateContributionProfit>;
    reasons: string[];
    qualityScore: number;
    isInternalSupply: boolean;
  }> = [];

  const productIds = (bestsellers ?? [])
    .map((row) => String((row as Record<string, unknown>).product_id ?? ""))
    .filter(Boolean);
  const { data: intelligenceRows, error: intelligenceError } = productIds.length === 0
    ? { data: [], error: null }
    : await supabase
        .from("opportunity_intelligence")
        .select("product_id,demand_score,search_fit_score,market_gap_score,competition_score,creative_score,selection_score,overall_confidence,selection_eligible,sellability_state,filter_state,profit_state,recommendation_summary,why_now")
        .in("product_id", productIds);
  if (intelligenceError) throw new Error(intelligenceError.message);

  const intelligenceByProduct = new Map(
    (intelligenceRows ?? []).map((row) => [String(row.product_id), row as Record<string, unknown>]),
  );

  for (const row of bestsellers ?? []) {
    const bestseller = row as Record<string, unknown>;
    const reasons: string[] = [];

    if (bestseller.rank === null) reasons.push("rank_unknown");
    if (!bestseller.title) reasons.push("title_unknown");
    if (!bestseller.image_url) reasons.push("image_unknown");
    if (!validHttpUrl(bestseller.image_url)) reasons.push("image_url_invalid");

    const { data: internalCatalog, error: internalError } = await supabase
      .from("tracer_supply_catalog")
      .select("*")
      .eq("bestseller_id", bestseller.id)
      .eq("orderable", true)
      .eq("status", "ready")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (internalError) throw new Error(internalError.message);

    let listing: Record<string, unknown> | undefined;
    let isInternalSupply = false;
    if (internalCatalog) {
      const { data: catalogVariant, error: catalogVariantError } = await supabase
        .from("tracer_supply_variants")
        .select("*")
        .eq("catalog_id", internalCatalog.id)
        .eq("orderable", true)
        .gt("inventory", 0)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (catalogVariantError) throw new Error(catalogVariantError.message);
      const internalCatalogVariant = (catalogVariant ?? null) as Record<string, unknown> | null;
      isInternalSupply = true;
      listing = {
        id: internalCatalog.id,
        supplier: "TRACER_INTERNAL",
        supplier_product_id:
          internalCatalogVariant?.internal_supply_product_id ??
          (internalCatalog.evidence as Record<string, unknown> | null)?.supply_product_id ??
          internalCatalog.tracer_sku,
        supplier_variant_id:
          internalCatalogVariant?.internal_supply_variant_id ??
          (internalCatalogVariant?.id ?? (internalCatalog.evidence as Record<string, unknown> | null)?.supply_variant_id),
        cost: internalCatalog.cost,
        shipping_cost: internalCatalog.shipping_cost ?? 0,
        handling_cost: internalCatalog.handling_cost ?? 0,
        inventory: internalCatalog.inventory,
        inventory_confirmed: true,
        tracking_available: internalCatalog.tracking_available === true,
        api_available: true,
        orderable: internalCatalog.orderable === true,
        identity_method: "tracer_catalog",
        identity_confidence: 1,
        currency: internalCatalog.currency ?? "JPY",
        catalog_sale_price: internalCatalog.sale_price,
        identity_status: "linked",
        external_id: internalCatalog.tracer_sku,
      };
    } else {
      const { data: listings, error: listingError } = await supabase
        .from("supplier_listings")
        .select("*")
        .eq("bestseller_id", bestseller.id)
        .eq("identity_status", "linked")
        .order("created_at", { ascending: false })
        .limit(5);
      if (listingError) throw new Error(listingError.message);
      listing = (listings ?? [])[0] as Record<string, unknown> | undefined;
    }

    if (!listing) {
      if (bestseller.price === null) reasons.push("selling_price_unknown");
      reasons.push("identity_not_confirmed");
      await markPipeline(String(bestseller.id), "SUPPLIER_INVESTIGATION", "blocked", "identity_not_confirmed");
      rejected.push({ id: String(bestseller.id), reasons });
      continue;
    }

    const supplierCapabilities = getSupplierCapabilities(String(listing.supplier ?? ""));
    const requiredCapabilities = [
      ["variant", supplierCapabilities.variant],
      ["inventory", supplierCapabilities.inventory],
      ["price", supplierCapabilities.price],
      ["shipping", supplierCapabilities.shipping],
      ["orderCreation", supplierCapabilities.orderCreation],
      ["payment", supplierCapabilities.payment],
      ["liveOrdering", supplierCapabilities.liveOrdering],
    ] as const;
    const missingSupplierCapabilities = requiredCapabilities
      .filter(([, supported]) => !supported)
      .map(([name]) => name);
    if (missingSupplierCapabilities.length > 0) {
      reasons.push(`supplier_capability_missing:${missingSupplierCapabilities.join(",")}`);
    }

    if (listing.cost === null) reasons.push("source_cost_unknown");
    if (isInternalSupply && asNumber(listing.catalog_sale_price) === null) reasons.push("selling_price_unknown");
    if (!isInternalSupply && bestseller.price === null) reasons.push("selling_price_unknown");
    if (isInternalSupply && (asNumber(listing.catalog_sale_price) ?? 0) <= 0) reasons.push("selling_price_invalid");
    if (!isInternalSupply && (asNumber(bestseller.price) ?? 0) <= 0) reasons.push("selling_price_invalid");
    if (listing.shipping_cost === null) reasons.push("shipping_unknown");
    if (listing.tracking_available !== true) reasons.push("tracking_unknown");
    if (listing.api_available !== true) reasons.push("supplier_api_unknown");
    if (listing.orderable !== true) reasons.push("supplier_not_orderable");
    if (listing.inventory_confirmed !== true) reasons.push("inventory_unknown");
    if (listing.inventory_confirmed === true && asNumber(listing.inventory) !== null && (asNumber(listing.inventory) ?? 0) <= 0) {
      reasons.push("inventory_zero");
    }

    const identityMethod = String(listing.identity_method ?? "");
    const identifierGradeMethods = new Set([
      "tracer_catalog",
      "asin",
      "jan",
      "gtin",
      "ean",
      "upc",
      "mpn",
      "brand_mpn",
    ]);
    if (!identifierGradeMethods.has(identityMethod)) reasons.push("identity_not_confirmed");
    const identityConfidence = asNumber(listing.identity_confidence);
    if (identityConfidence === null || identityConfidence < 0.88) reasons.push("identity_confidence_low");

    const autoProcurement = getAutoProcurementEligibility(String(listing.supplier ?? ""));
    if (!autoProcurement.eligible) {
      reasons.push(`supplier_auto_procurement_capability_missing:${autoProcurement.missing.join("|")}`);
    }

    if (!isInternalSupply &&
      typeof listing.supplier_variant_id !== "string" &&
      !(String(listing.supplier ?? "").toLowerCase() === "cjdropshipping" && typeof listing.cj_variant_id === "string")
    ) {
      reasons.push("supplier_variant_unknown");
    }

    const profit = simulateContributionProfit({
      sellingPrice: isInternalSupply ? asNumber(listing.catalog_sale_price) : asNumber(bestseller.price),
      sellingCurrency: isInternalSupply ? (typeof listing.currency === "string" ? listing.currency : null) : (typeof bestseller.currency === "string" ? bestseller.currency : null),
      sellingProvider: isInternalSupply ? "tracer_internal" : String(bestseller.source ?? "marketplace"),
      sourceCost: asNumber(listing.cost),
      sourceCurrency: typeof listing.currency === "string" ? listing.currency : null,
      sourceProvider: String(listing.supplier ?? "cj"),
      internationalShipping: asNumber(listing.shipping_cost),
      domesticShipping: null,
      shippingCurrency: typeof listing.currency === "string" ? listing.currency : null,
      sourceFxRateToSelling:
        typeof bestseller.currency === "string" && typeof listing.currency === "string" && bestseller.currency.trim().toUpperCase() === "JPY" && listing.currency.trim().toUpperCase() === "USD"
          ? fxQuote?.rate ?? null
          : null,
      sourceFxRateSource:
        typeof bestseller.currency === "string" && typeof listing.currency === "string" && bestseller.currency.trim().toUpperCase() === "JPY" && listing.currency.trim().toUpperCase() === "USD"
          ? fxQuote?.source ?? null
          : null,
    });

    if (!profit.calculable) reasons.push(profit.incalculableReason ?? "profit_unknown");
    if (profit.shippingUnknown) reasons.push("shipping_unknown");
    if (profit.contributionProfit !== null && profit.contributionProfit <= 0) reasons.push("profit_not_positive");

    if (reasons.length > 0) {
      await markPipeline(String(bestseller.id), "SALES_TEST", "blocked", reasons.join(","));
      rejected.push({ id: String(bestseller.id), reasons });
      continue;
    }

    const rank = asNumber(bestseller.rank);
    const reviews = asNumber(bestseller.review_count) ?? 0;
    const inventory = asNumber(listing.inventory) ?? 0;
    const margin = profit.contributionMargin ?? 0;
    const rankScore = rank !== null && rank > 0 ? Math.max(0, Math.min(100, 100 - Math.log10(rank) * 20)) : 0;
    const reviewScore = Math.min(100, Math.log10(Math.max(1, reviews) + 1) * 25);
    const marginScore = Math.max(0, Math.min(100, margin));
    const inventoryScore = Math.min(100, Math.log10(Math.max(1, inventory) + 1) * 30);
    const identityScore = Math.max(0, Math.min(100, (identityConfidence ?? 0) * 100));
    const trackingScore = listing.tracking_available === true ? 100 : 0;
    const intelligence = intelligenceByProduct.get(String(bestseller.product_id ?? ""));
    if (!intelligence) {
      reasons.push("opportunity_intelligence_missing");
    } else {
      if (intelligence.selection_eligible !== true) reasons.push("intelligence_selection_ineligible");
      const sellabilityState = String(intelligence.sellability_state ?? "");
      if (sellabilityState !== "TEST_READY") reasons.push("sellability_not_ready");
      if (String(intelligence.filter_state ?? "") !== "PASS") reasons.push("intelligence_filter_not_pass");
      if (String(intelligence.profit_state ?? "") !== "PROFIT_OK") reasons.push("intelligence_profit_not_ok");
      if (asNumber(intelligence.demand_score) === null) reasons.push("demand_evidence_missing");
      if (asNumber(intelligence.search_fit_score) === null) reasons.push("search_fit_evidence_missing");
      if (asNumber(intelligence.market_gap_score) === null) reasons.push("market_gap_evidence_missing");
      const intelligenceConfidence = asNumber(intelligence.overall_confidence);
      if (intelligenceConfidence === null || intelligenceConfidence < 0.6) reasons.push("intelligence_confidence_low");
    }
    if (reasons.length > 0) {
      await markPipeline(String(bestseller.id), "SALES_TEST", "blocked", reasons.join(","));
      rejected.push({ id: String(bestseller.id), reasons });
      continue;
    }
    const demandScore = asNumber(intelligence?.demand_score) ?? 0;
    const searchFitScore = asNumber(intelligence?.search_fit_score) ?? 0;
    const marketGapScore = asNumber(intelligence?.market_gap_score) ?? 0;
    const competitionScore = asNumber(intelligence?.competition_score) ?? 0;
    const creativeScore = asNumber(intelligence?.creative_score) ?? 0;
    const selectionScore = asNumber(intelligence?.selection_score) ?? 0;
    const intelligenceConfidence = asNumber(intelligence?.overall_confidence) ?? 0;

    const womenBonus = womenProductPriority({
      title: String(bestseller.title ?? ""),
      category: String((bestseller as Record<string, unknown>).category ?? ""),
    }).bonus;
    const qualityScore =
      rankScore * 0.10 + reviewScore * 0.05 + marginScore * 0.20 + inventoryScore * 0.05 +
      identityScore * 0.10 + trackingScore * 0.10 + demandScore * 0.15 + searchFitScore * 0.10 +
      marketGapScore * 0.05 + competitionScore * 0.05 + creativeScore * 0.025 + selectionScore * 0.025 +
      intelligenceConfidence * 100 * 0.025 + womenBonus;

    eligible.push({
      bestseller,
      listing,
      profit,
      qualityScore,
      isInternalSupply,
      reasons: [
        `quality_score_${qualityScore.toFixed(1)}`, `women_priority_${womenBonus}`, `demand_score_${demandScore.toFixed(1)}`,
        `search_fit_score_${searchFitScore.toFixed(1)}`, `market_gap_score_${marketGapScore.toFixed(1)}`,
        `competition_score_${competitionScore.toFixed(1)}`, `selection_score_${selectionScore.toFixed(1)}`,
        `intelligence_confidence_${intelligenceConfidence.toFixed(2)}`, `marketplace_rank_${String(bestseller.rank)}`,
        `identity_${String(listing.identity_method)}`, `margin_${margin.toFixed(1)}pct`,
        `inventory_${String(inventory)}`, `supplier_${String(listing.supplier)}`,
      ],
    });
  }

  eligible.sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    const rankA = asNumber(a.bestseller.rank) ?? Number.POSITIVE_INFINITY;
    const rankB = asNumber(b.bestseller.rank) ?? Number.POSITIVE_INFINITY;
    return rankA - rankB;
  });
  const chosen = eligible.slice(0, limit);
  const chosenIds = new Set(chosen.map((item) => String(item.bestseller.id)));
  for (const item of eligible) {
    const id = String(item.bestseller.id);
    if (!chosenIds.has(id)) await markPipeline(id, "SALES_TEST", "blocked", "sales_test_limit");
  }
  let published = 0;

  for (const item of chosen) {
    const productId = String(item.bestseller.product_id ?? "");
    if (!productId) continue;
    const slug = slugify(String(item.bestseller.title), String(item.bestseller.id));

    await markPipeline(String(item.bestseller.id), "SELECTED", "selected", "sales_test_selected");

    const listingPayload = {
      product_id: productId,
      bestseller_id: item.bestseller.id,
      supplier_listing_id: item.isInternalSupply ? null : item.listing.id,
      slug,
      title: item.bestseller.title,
      description: item.isInternalSupply
        ? "TRACER独自供給カタログの商品です。需要・価格・在庫・注文可否をTRACER側で管理しています。"
        : "市場ランキングで確認された売れ筋商品です。仕入は識別子で同一商品と確認できた無在庫仕入先のみを使います。",
      image_url: item.bestseller.image_url,
      selling_price: item.isInternalSupply ? item.listing.catalog_sale_price : item.bestseller.price,
      currency: item.isInternalSupply ? item.listing.currency : item.bestseller.currency,
      supplier_name: item.listing.supplier,
      supplier_product_id: item.listing.supplier_product_id ?? item.listing.external_id,
      supplier_variant_id: item.listing.supplier_variant_id ?? item.listing.cj_variant_id,
      source_cost: item.profit.sourceCost,
      shipping_cost: item.profit.internationalShipping,
      inventory: asNumber(item.listing.inventory),
      orderable: item.listing.orderable ?? false,
      tracking_available: item.listing.tracking_available,
      identity_method: item.listing.identity_method,
      identity_confidence: item.listing.identity_confidence,
      contribution_profit: item.profit.contributionProfit,
      contribution_margin: item.profit.contributionMargin,
      published: true,
      selection_reasons: [SALES_TEST_GATE_PASSED, "sales_test_gate:market", ...item.reasons],
      missing: [],
      pipeline_stage: "PUBLISHED",
      pipeline_status: "published",
      pipeline_reason: SALES_TEST_GATE_PASSED,
      pipeline_error: null,
      pipeline_updated_at: fetchedAt,
      published_at: fetchedAt,
      updated_at: fetchedAt,
    };
    const existing = await supabase.from("shop_listings").select("id").eq("slug", slug).maybeSingle();
    let upsert: { data: { id: string } | null; error: { message: string } | null };
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data?.id) {
      const updated = await supabase.from("shop_listings").update(listingPayload).eq("id", existing.data.id).select("id").single();
      upsert = { data: updated.data as { id: string } | null, error: updated.error ? { message: updated.error.message } : null };
    } else {
      const inserted = await supabase.from("shop_listings").insert(listingPayload).select("id").single();
      upsert = { data: inserted.data as { id: string } | null, error: inserted.error ? { message: inserted.error.message } : null };
    }

    if (upsert.error) {
      await markPipeline(String(item.bestseller.id), "PRODUCT_CREATED", "failed", "shop_listing_upsert_failed", upsert.error.message);
      throw new Error(upsert.error.message);
    }
    if (upsert.data?.id) publishedListingIds.push(String(upsert.data.id));
    published += 1;

    await markPipeline(String(item.bestseller.id), "PUBLISHED", "published", "shop_listing_created");

    await writeEvidence({
      productId,
      bestsellerId: String(item.bestseller.id),
      supplierListingId: String(item.listing.id),
      source: "sales_test_selection",
      url: `/shop/${slug}`,
      fetchedAt,
      fieldName: "shop_published",
      fieldValue: "true",
      evidenceClass: "actual",
      confidence: 0.9,
      metadata: { reasons: item.reasons },
    });
  }

  return { published, publishedListingIds, considered: (bestsellers ?? []).length, rejected: rejected.slice(0, 20) };
}
