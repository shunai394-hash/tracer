import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { fetchCJProductVariants, fetchCJVariantByVid, fetchCJVariantStock, getCJFreightOptions, getCJProductDetail, searchCJProducts } from "@/lib/sources/cj";

export const runtime = "nodejs";
export const maxDuration = 300;

// Read-only catalog discovery for the discontinued five-color handbag.
// Search color-specific terms as well as style terms; caller input is ignored.
const SEARCH_TERMS = [
  "Pattern Woven Handbag Women Leather Handbags",
  "woven leather handbag women",
  "braided woven handbag women",
  "woven leather handbag red",
  "woven leather handbag blue",
  "woven leather handbag gray",
  "braided leather handbag black",
  "woven leather shoulder bag women",
] as const;
const MAX_CANDIDATES = 10;
const MAX_VARIANTS_PER_PRODUCT = 40;
const MAX_EXACT_VARIANT_CHECKS = 30;

function safeImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function titleScore(title: string): number {
  const normalized = title.toLowerCase();
  return [
    ["handbag", 5],
    ["woven", 5],
    ["braid", 3],
    ["leather", 2],
    ["women", 1],
    ["shoulder bag", 2],
  ].reduce((score, [term, points]) => score + (normalized.includes(String(term)) ? Number(points) : 0), 0);
}

export async function POST(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const searches: Array<{ query: string; totalRecords: number; returned: number; error: string | null }> = [];
  const candidates = new Map<string, {
    id: string;
    title: string;
    sku: string | null;
    price: string | null;
    imageUrl: string | null;
    inventory: number | null;
    listedNum: number | null;
    saleStatus: string | null;
    shippingCost: string | null;
  }>();

  for (const query of SEARCH_TERMS) {
    try {
      const result = await searchCJProducts(query, { page: 1, size: 10 });
      searches.push({ query, totalRecords: result.totalRecords, returned: result.products.length, error: null });
      for (const product of result.products) {
        const current = candidates.get(product.id);
        if (!current || titleScore(product.title) > titleScore(current.title)) {
          candidates.set(product.id, {
            id: product.id,
            title: product.title,
            sku: product.sku,
            price: product.price,
            imageUrl: safeImageUrl(product.imageUrl),
            inventory: product.inventory,
            listedNum: product.listedNum,
            saleStatus: product.saleStatus,
            shippingCost: product.shippingCost,
          });
        }
      }
    } catch (error) {
      searches.push({
        query,
        totalRecords: 0,
        returned: 0,
        error: error instanceof Error ? error.message.slice(0, 160) : "search_failed",
      });
    }
  }

  const ranked = [...candidates.values()]
    .filter((product) => titleScore(product.title) >= 7)
    .sort((a, b) => titleScore(b.title) - titleScore(a.title))
    .slice(0, MAX_CANDIDATES);

  const detailed = [];
  let exactVariantChecks = 0;
  for (const candidate of ranked) {
    try {
      const [detail, variants] = await Promise.all([
        getCJProductDetail(candidate.id),
        fetchCJProductVariants(candidate.id),
      ]);
      const exactVariants = [];
      for (const variant of variants.slice(0, MAX_VARIANTS_PER_PRODUCT)) {
        if (exactVariantChecks >= MAX_EXACT_VARIANT_CHECKS) break;
        exactVariantChecks += 1;
        try {
          const exact = await fetchCJVariantByVid(variant.vid);
          const freight = exact ? await getCJFreightOptions(exact.vid, {
            startCountryCode: "CN",
            endCountryCode: "JP",
            quantity: 1,
          }) : [];
          let variantStockQuantity: number | null = null;
          let variantStockError: string | null = null;
          try {
            // This endpoint reports aggregate warehouse stock. It does not prove
            // a Japan-based origin; country eligibility still requires verifiedInventoryByCountry.
            variantStockQuantity = await fetchCJVariantStock(variant.vid);
          } catch (stockError) {
            variantStockError = stockError instanceof Error ? stockError.message.slice(0, 160) : "variant_stock_lookup_failed";
          }
          exactVariants.push({
            requestedVid: variant.vid,
            exactVidMatched: exact?.vid === variant.vid,
            exactProductId: exact?.productId ?? null,
            exactSku: exact?.sku ?? null,
            exactColorOrOption: exact?.nameEn ?? null,
            exactVariantImageUrl: safeImageUrl(exact?.variantImage),
            verifiedInventoryByCountry: exact?.inventoryByCountry ?? [],
            variantStockQuantity,
            variantStockError,
            japanFreightOptions: freight,
            verificationError: null,
          });
        } catch (error) {
          exactVariants.push({
            requestedVid: variant.vid,
            exactVidMatched: false,
            exactSku: null,
            exactColorOrOption: null,
            exactVariantImageUrl: null,
            verifiedInventoryByCountry: [],
            variantStockQuantity: null,
            variantStockError: "exact_variant_lookup_failed",
            japanFreightOptions: [],
            verificationError: error instanceof Error ? error.message.slice(0, 160) : "exact_variant_check_failed",
          });
        }
      }
      detailed.push({
        ...candidate,
        detailTitle: detail?.title ?? null,
        detailSku: detail?.sku ?? null,
        detailPrice: detail?.price ?? null,
        detailImageUrl: safeImageUrl(detail?.imageUrl),
        detailInventory: detail?.inventory ?? null,
        detailListedNum: detail?.listedNum ?? null,
        detailSaleStatus: detail?.saleStatus ?? null,
        // Raw listing freight is not a Japan-specific shipping quote.
        listingShippingCost: detail?.shippingCost ?? candidate.shippingCost,
        variants: variants.slice(0, MAX_VARIANTS_PER_PRODUCT).map((variant) => ({
          vid: variant.vid,
          productId: variant.productId,
          sku: variant.sku,
          colorOrOption: variant.nameEn,
          price: variant.sellPrice,
          imageUrl: safeImageUrl(variant.variantImage),
          verifiedInventoryByCountry: variant.inventoryByCountry ?? [],
        })),
        variantCount: variants.length,
        exactVariants,
        exactVariantsTruncated: variants.length > exactVariants.length,
        error: null,
      });
    } catch (error) {
      detailed.push({
        ...candidate,
        variants: [],
        variantCount: 0,
        error: error instanceof Error ? error.message.slice(0, 160) : "detail_lookup_failed",
      });
    }
  }

  const imageVariantCount = detailed.reduce(
    (sum, product) => sum + product.variants.filter((variant) => Boolean(variant.imageUrl)).length,
    0,
  );
  return NextResponse.json({
    ok: searches.some((search) => search.error === null),
    readOnly: true,
    originalProductId: "1360428949011828736",
    searchTerms: SEARCH_TERMS,
    searches,
    candidateCount: detailed.length,
    imageVariantCount,
    exactVariantChecks,
    exactVariantCheckLimit: MAX_EXACT_VARIANT_CHECKS,
    freightNote: "Only japanFreightOptions from getCJFreightOptions are Japan-specific quotes; listingShippingCost is raw listing data.",
    variantStockNote: "variantStockQuantity is aggregate stock returned by queryByVid stock lookup; it does not identify a country or verified shipping origin. Japan eligibility still requires verifiedInventoryByCountry.",
    candidates: detailed,
  }, { status: searches.some((search) => search.error === null) ? 200 : 207 });
}
