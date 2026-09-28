import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { simulateContributionProfit } from "@/lib/intelligence/simulate-profit";
import { writeEvidence } from "@/lib/market/evidence-ledger";
import { getObservedUsdToJpyRate } from "@/lib/intelligence/fx";

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

  // Must be the exact same candidate set investigate-dropship.ts just
  // investigated (same ordering key and limit — see candidate-batch.ts),
  // or the supplier_listings rows that stage just wrote will never be
  // found here and every candidate falls through as identity_not_confirmed
  // even when a linked listing genuinely exists for it.
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
    qualityScore: number;
    reasons: string[];
  }> = [];

  for (const row of bestsellers ?? []) {
    const bestseller = row as Record<string, unknown>;
    const reasons: string[] = [];

    if (bestseller.rank === null) reasons.push("rank_unknown");
    if (!bestseller.title) reasons.push("title_unknown");
    if (bestseller.price === null) reasons.push("selling_price_unknown");
    if (!bestseller.image_url) reasons.push("image_unknown");

    const { data: listings, error: listingError } = await supabase
      .from("supplier_listings")
      .select("*")
      .eq("bestseller_id", bestseller.id)
      .eq("identity_status", "linked")
      .order("created_at", { ascending: false })
      .limit(5);

    if (listingError) throw new Error(listingError.message);
    const listing = (listings ?? [])[0] as Record<string, unknown> | undefined;

    if (!listing) {
      reasons.push("identity_not_confirmed");
      await markPipeline(String(bestseller.id), "SUPPLIER_INVESTIGATION", "blocked", "identity_not_confirmed");
      rejected.push({ id: String(bestseller.id), reasons });
      continue;
    }
    if (listing.cost === null) reasons.push("source_cost_unknown");
    if (listing.shipping_cost === null) reasons.push("shipping_unknown");
    if (listing.tracking_available !== true) reasons.push("tracking_unknown");
    if (listing.api_available !== true) reasons.push("supplier_api_unknown");
    if (listing.orderable !== true) reasons.push("supplier_not_orderable");
    if (listing.inventory_confirmed !== true) reasons.push("inventory_unknown");
    if (listing.inventory_confirmed === true && asNumber(listing.inventory) !== null && (asNumber(listing.inventory) ?? 0) <= 0) {
      reasons.push("inventory_zero");
    }

    // Defense in depth: historical supplier rows may predate the current
    // identity implementation. Publication is allowed only for an
    // identifier-grade method, even if an old row was incorrectly marked
    // linked. Title/image/none are never sales identity evidence.
    const identityMethod = String(listing.identity_method ?? "");
    const identifierGradeMethods = new Set([
      "asin",
      "jan",
      "gtin",
      "ean",
      "upc",
      "mpn",
      "brand_mpn",
    ]);
    if (!identifierGradeMethods.has(identityMethod)) {
      reasons.push("identity_not_confirmed");
    }
    const identityConfidence = asNumber(listing.identity_confidence);
    if (identityConfidence === null || identityConfidence < 0.88) {
      reasons.push("identity_confidence_low");
    }

    // CJ fulfillment requires a concrete variant ID. A product-level match
    // without a variant cannot be safely published because a later refresh
    // could otherwise cause fulfillment to select a different variant.
    if (
      String(listing.supplier ?? "").toLowerCase() === "cjdropshipping" &&
      typeof listing.supplier_variant_id !== "string" &&
      typeof listing.cj_variant_id !== "string"
    ) {
      reasons.push("supplier_variant_unknown");
    }

    const profit = simulateContributionProfit({
      sellingPrice: asNumber(bestseller.price),
      sellingCurrency: typeof bestseller.currency === "string" ? bestseller.currency : null,
      sellingProvider: String(bestseller.source ?? "marketplace"),
      sourceCost: asNumber(listing.cost),
      sourceCurrency: typeof listing.currency === "string" ? listing.currency : null,
      sourceProvider: String(listing.supplier ?? "cj"),
      internationalShipping: asNumber(listing.shipping_cost),
      domesticShipping: null,
      shippingCurrency: typeof listing.currency === "string" ? listing.currency : null,
      sourceFxRateToSelling:
        typeof bestseller.currency === "string" &&
        typeof listing.currency === "string" &&
        bestseller.currency.trim().toUpperCase() === "JPY" &&
        listing.currency.trim().toUpperCase() === "USD"
          ? fxQuote?.rate ?? null
          : null,
      sourceFxRateSource:
        typeof bestseller.currency === "string" &&
        typeof listing.currency === "string" &&
        bestseller.currency.trim().toUpperCase() === "JPY" &&
        listing.currency.trim().toUpperCase() === "USD"
          ? fxQuote?.source ?? null
          : null,
    });

    if (!profit.calculable) reasons.push(profit.incalculableReason ?? "profit_unknown");
    if (profit.shippingUnknown) reasons.push("shipping_unknown");
    if (profit.contributionProfit !== null && profit.contributionProfit <= 0) {
      reasons.push("profit_not_positive");
    }

    if (reasons.length > 0) {
      await markPipeline(
        String(bestseller.id),
        "SALES_TEST",
        "blocked",
        reasons.join(","),
      );
      rejected.push({ id: String(bestseller.id), reasons });
      continue;
    }

    const rank = asNumber(bestseller.rank);
    const reviews = asNumber(bestseller.review_count) ?? 0;
    const inventory = asNumber(listing.inventory) ?? 0;
    const margin = profit.contributionMargin ?? 0;
    const rankScore = rank !== null && rank > 0 ? Math.max(0, Math.min(100, 100 - Math.log10(rank) * 20)) : 0;
    const reviewScore = Math.min(100, Math.log10(Math.max(1, reviews) + 1) * 25);
    const marginScore = Math.max(0, Math.min(100, margin * 100));
    const inventoryScore = Math.min(100, Math.log10(Math.max(1, inventory) + 1) * 30);
    const identityScore = Math.max(0, Math.min(100, identityConfidence * 100));
    const trackingScore = listing.tracking_available === true ? 100 : 0;
    const qualityScore =
      rankScore * 0.25 +
      reviewScore * 0.10 +
      marginScore * 0.25 +
      inventoryScore * 0.10 +
      identityScore * 0.15 +
      trackingScore * 0.15;

    eligible.push({
      bestseller,
      listing,
      profit,
      qualityScore,
      reasons: [
        `quality_score_${qualityScore.toFixed(1)}`,
        `marketplace_rank_${String(bestseller.rank)}`,
        `identity_${String(listing.identity_method)}`,
        `margin_${(margin * 100).toFixed(1)}pct`,
        `inventory_${String(inventory)}`,
        `supplier_${String(listing.supplier)}`,
      ],
    });
  }

  // Rank alone is not enough for a high-quality sourcing decision.
  // Score observed demand, contribution margin, identity confidence,
  // inventory depth and tracking reliability together. This deliberately
  // keeps every component evidence-based; missing data already fails the
  // hard gates above.
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
    if (!chosenIds.has(id)) {
      await markPipeline(id, "SALES_TEST", "blocked", "sales_test_limit");
    }
  }
  let published = 0;

  // Publishing a new sales-test candidate must not unpublish the existing
  // catalog. Market observation and sourcing decisions are independent:
  // a sourcing run that finds zero eligible candidates is not permission to
  // erase products that were already public.
  for (const item of chosen) {
    const productId = String(item.bestseller.product_id ?? "");
    if (!productId) continue;
    const slug = slugify(String(item.bestseller.title), String(item.bestseller.id));

    await markPipeline(String(item.bestseller.id), "SELECTED", "selected", "sales_test_selected");

    const upsert = await supabase
      .from("shop_listings")
      .upsert(
        {
          product_id: productId,
          bestseller_id: item.bestseller.id,
          supplier_listing_id: item.listing.id,
          slug,
          title: item.bestseller.title,
          description:
            "市場ランキングで確認された売れ筋商品です。仕入は識別子で同一商品と確認できた無在庫仕入先のみを使います。",
          image_url: item.bestseller.image_url,
          selling_price: item.bestseller.price,
          currency: item.bestseller.currency,
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
          selection_reasons: item.reasons,
          missing: [],
          published_at: fetchedAt,
          updated_at: fetchedAt,
        },
        { onConflict: "slug" },
      )
      .select("id")
      .single();

    if (upsert.error) {
      await markPipeline(
        String(item.bestseller.id),
        "PRODUCT_CREATED",
        "failed",
        "shop_listing_upsert_failed",
        upsert.error.message,
      );
      throw new Error(upsert.error.message);
    }
    if (upsert.data?.id) publishedListingIds.push(String(upsert.data.id));
    published += 1;

    const listingId = String(upsert.data?.id ?? "");
    if (listingId) {
      const { error: listingStateError } = await supabase
        .from("shop_listings")
        .update({
          pipeline_stage: "PUBLISHED",
          pipeline_status: "published",
          pipeline_reason: "sales_test_gate_passed",
          pipeline_error: null,
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", listingId);
      if (listingStateError) throw new Error(listingStateError.message);
    }
    await markPipeline(
      String(item.bestseller.id),
      "PUBLISHED",
      "published",
      "shop_listing_created",
    );

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

  return {
    published,
    publishedListingIds,
    considered: (bestsellers ?? []).length,
    rejected: rejected.slice(0, 20),
  };
}
