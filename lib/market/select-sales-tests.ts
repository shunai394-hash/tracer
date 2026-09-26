import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { simulateContributionProfit } from "@/lib/intelligence/simulate-profit";
import { writeEvidence } from "@/lib/market/evidence-ledger";
import { BESTSELLER_CANDIDATE_BATCH_SIZE } from "@/lib/market/candidate-batch";
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
  considered: number;
  rejected: Array<{ id: string; reasons: string[] }>;
};

/**
 * Publish at most 3 shop listings. Every gate is observed data.
 * Title-only identity never qualifies.
 */
export async function selectAndPublishSalesTests(
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
  const { data: bestsellers, error } = await supabase
    .from("marketplace_bestsellers")
    .select("*")
    .order("fetched_at", { ascending: false })
    .limit(BESTSELLER_CANDIDATE_BATCH_SIZE);

  if (error) throw new Error(error.message);

  const rejected: Array<{ id: string; reasons: string[] }> = [];
  const eligible: Array<{
    bestseller: Record<string, unknown>;
    listing: Record<string, unknown>;
    profit: ReturnType<typeof simulateContributionProfit>;
    reasons: string[];
  }> = [];

  for (const row of bestsellers ?? []) {
    const bestseller = row as Record<string, unknown>;
    const reasons: string[] = [];

    if (bestseller.rank === null) reasons.push("rank_unknown");
    if (!bestseller.title) reasons.push("title_unknown");
    if (bestseller.price === null) reasons.push("selling_price_unknown");

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
      rejected.push({ id: String(bestseller.id), reasons });
      continue;
    }
    if (listing.cost === null) reasons.push("source_cost_unknown");
    if (listing.shipping_cost === null) reasons.push("shipping_unknown");
    if (listing.tracking_available !== true) reasons.push("tracking_unknown");
    if (listing.api_available !== true) reasons.push("supplier_api_unknown");

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
      rejected.push({ id: String(bestseller.id), reasons });
      continue;
    }

    eligible.push({
      bestseller,
      listing,
      profit,
      reasons: [
        `marketplace_rank_${String(bestseller.rank)}`,
        `identity_${String(listing.identity_method)}`,
        `supplier_${String(listing.supplier)}`,
      ],
    });
  }

  // Within the current batch, still prefer the best-ranked products —
  // fetched_at only scopes the candidate set to "this run"; it says
  // nothing about which of those products sell best.
  eligible.sort((a, b) => {
    const rankA = typeof a.bestseller.rank === "number" ? a.bestseller.rank : Number.POSITIVE_INFINITY;
    const rankB = typeof b.bestseller.rank === "number" ? b.bestseller.rank : Number.POSITIVE_INFINITY;
    return rankA - rankB;
  });
  const chosen = eligible.slice(0, limit);
  let published = 0;

  await supabase
    .from("shop_listings")
    .update({ published: false, updated_at: fetchedAt })
    .eq("published", true);

  for (const item of chosen) {
    const productId = String(item.bestseller.product_id ?? "");
    if (!productId) continue;
    const slug = slugify(String(item.bestseller.title), String(item.bestseller.id));

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

    if (upsert.error) throw new Error(upsert.error.message);
    published += 1;

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
    considered: (bestsellers ?? []).length,
    rejected: rejected.slice(0, 20),
  };
}
