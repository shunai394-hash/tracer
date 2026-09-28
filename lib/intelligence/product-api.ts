import "server-only";

import { getCJConfig } from "@/lib/config/env";
import {
  searchCJProducts,
  getCJProductDetail,
  fetchCJProductVariants,
  fetchCJVariantStock,
  calculateCJFreight,
} from "@/lib/sources/cj";
import {
  getOrosyProductDetail,
  getOrosyShippingQuote,
  searchOrosyProducts,
} from "@/lib/sources/orosy";
import {
  identifiersFromRecord,
  matchProductIdentity,
  type ProductIdentifiers,
} from "@/lib/market/identifiers";

export type ProductIntelligenceInput = {
  asin?: string | null;
  jan?: string | null;
  gtin?: string | null;
  ean?: string | null;
  upc?: string | null;
  mpn?: string | null;
  url?: string | null;
  title?: string | null;
  brand?: string | null;
  imageUrl?: string | null;
};

export type ProductIntelligenceOffer = {
  supplier: "cj" | "orosy";
  productId: string;
  variantId: string | null;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  identity: {
    confirmed: boolean;
    method: string;
    confidence: number;
    rationale: string;
  };
  price: number | null;
  shippingCost: number | null;
  inventory: number | null;
  orderable: boolean;
  trackingAvailable: boolean | null;
  searchable: boolean;
  evidence: string[];
};

export type ProductIntelligenceResult = {
  query: ProductIdentifiers;
  market: {
    title: string | null;
    brand: string | null;
    imageUrl: string | null;
  };
  offers: ProductIntelligenceOffer[];
  suppliers: {
    cj: "available" | "not_configured" | "error";
    orosy: "available" | "not_configured" | "error";
  };
  sellability: {
    eligible: boolean;
    reason:
      | "eligible"
      | "no_identity_confirmed_offer"
      | "no_orderable_offer"
      | "no_inventory_confirmed";
  };
};

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function marketRecord(input: ProductIntelligenceInput): Record<string, unknown> {
  return {
    asin: input.asin,
    jan: input.jan,
    gtin: input.gtin,
    ean: input.ean,
    upc: input.upc,
    mpn: input.mpn,
    url: input.url,
    title: input.title,
    brand: input.brand,
    image_url: input.imageUrl,
  };
}

function searchQueries(ids: ProductIdentifiers): string[] {
  return [
    ids.jan,
    ids.gtin,
    ids.ean,
    ids.upc,
    ids.mpn,
  ].filter((v, i, a): v is string => Boolean(v) && a.indexOf(v) === i);
}

async function investigateCJ(
  market: ProductIntelligenceInput,
  ids: ProductIdentifiers,
): Promise<{ status: ProductIntelligenceResult["suppliers"]["cj"]; offers: ProductIntelligenceOffer[] }> {
  if (!getCJConfig().apiKey) {
    return { status: "not_configured", offers: [] };
  }

  const offers: ProductIntelligenceOffer[] = [];
  try {
    for (const query of searchQueries(ids).slice(0, 3)) {
      const result = await searchCJProducts(query, { page: 1, size: 10 });
      for (const candidate of result.products) {
        const candidateIds = identifiersFromRecord({
          gtin: candidate.barcode,
          title: candidate.title,
        });
        const identity = matchProductIdentity({
          market: {
            ...ids,
            brand: market.brand ?? null,
            title: market.title ?? null,
            imageUrl: market.imageUrl ?? null,
          },
          supply: {
            ...candidateIds,
            title: candidate.title,
            imageUrl: candidate.imageUrl,
          },
        });
        if (!identity.salesEligible) continue;

        const detail = await getCJProductDetail(candidate.id);
        if (!detail) continue;

        const variants = await fetchCJProductVariants(candidate.id, {
          countryCode: "JP",
        });
        const matchingVariants = variants.filter((variant) => {
          const variantIds = identifiersFromRecord({
            gtin: variant.barcode,
            mpn: variant.sku,
          });
          return matchProductIdentity({
            market: {
              ...ids,
              brand: market.brand ?? null,
              title: market.title ?? null,
              imageUrl: market.imageUrl ?? null,
            },
            supply: {
              ...variantIds,
              title: detail.title,
              imageUrl: detail.imageUrl,
            },
          }).salesEligible;
        });

        const variant = matchingVariants.length === 1 ? matchingVariants[0] : null;
        const inventory = variant ? await fetchCJVariantStock(variant.vid) : null;
        const shippingCost = variant
          ? await calculateCJFreight(variant.vid, { endCountryCode: "JP", quantity: 1 })
          : null;
        const orderable = Boolean(
          variant &&
          inventory !== null &&
          inventory > 0 &&
          shippingCost !== null,
        );

        offers.push({
          supplier: "cj",
          productId: candidate.id,
          variantId: variant?.vid ?? null,
          title: detail.title,
          brand: null,
          imageUrl: detail.imageUrl,
          identity: {
            confirmed: true,
            method: identity.method,
            confidence: identity.confidence,
            rationale: identity.rationale,
          },
          price: numberOrNull(variant?.sellPrice ?? detail.price),
          shippingCost,
          inventory,
          orderable,
          trackingAvailable: null,
          searchable: true,
          evidence: [
            "supplier product matched by identifier-grade identity",
            variant ? "single matching variant confirmed" : "variant not uniquely confirmed",
          ],
        });

        if (offers.length >= 5) return { status: "available", offers };
      }
    }
    return { status: "available", offers };
  } catch (error) {
    console.warn("[product-intelligence] CJ provider failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "error", offers };
  }
}

async function investigateOrosy(
  market: ProductIntelligenceInput,
  ids: ProductIdentifiers,
): Promise<{ status: ProductIntelligenceResult["suppliers"]["orosy"]; offers: ProductIntelligenceOffer[] }> {
  const hasConfig = Boolean(process.env.OROSY_API_URL && process.env.OROSY_API_KEY);
  if (!hasConfig) return { status: "not_configured", offers: [] };

  const offers: ProductIntelligenceOffer[] = [];
  try {
    for (const query of searchQueries(ids).slice(0, 3)) {
      const products = await searchOrosyProducts(query);
      for (const product of products.slice(0, 5)) {
        const detail = await getOrosyProductDetail(product.id);
        if (!detail) continue;

        const variationOffers = detail.variations.filter((variation) => {
          const variationIds = identifiersFromRecord({
            jan: variation.jan,
            gtin: variation.jan,
          });
          return matchProductIdentity({
            market: {
              ...ids,
              brand: market.brand ?? null,
              title: market.title ?? null,
              imageUrl: market.imageUrl ?? null,
            },
            supply: {
              ...variationIds,
              mpn: detail.productNumber,
              title: detail.title,
              brand: detail.brand,
              imageUrl: detail.imageUrl,
            },
          }).salesEligible;
        });

        const variation = variationOffers.length === 1 ? variationOffers[0] : null;
        if (!variation) continue;

        const identity = matchProductIdentity({
          market: {
            ...ids,
            brand: market.brand ?? null,
            title: market.title ?? null,
            imageUrl: market.imageUrl ?? null,
          },
          supply: {
            ...identifiersFromRecord({ jan: variation.jan }),
            mpn: detail.productNumber,
            title: detail.title,
            brand: detail.brand,
            imageUrl: detail.imageUrl,
          },
        });
        const shipping = await getOrosyShippingQuote(detail.id);
        const orderable = Boolean(
          detail.orderable === true &&
          variation.stockQty !== null &&
          variation.stockQty > 0 &&
          !shipping.unresolved,
        );

        offers.push({
          supplier: "orosy",
          productId: detail.id,
          variantId: variation.variationId,
          title: detail.title,
          brand: detail.brand,
          imageUrl: detail.imageUrl,
          identity: {
            confirmed: true,
            method: identity.method,
            confidence: identity.confidence,
            rationale: identity.rationale,
          },
          price: variation.buyerPrice,
          shippingCost: shipping.amount,
          inventory: variation.stockQty,
          orderable,
          trackingAvailable: null,
          searchable: true,
          evidence: [
            "supplier product matched by identifier-grade identity",
            "variation uniquely confirmed",
          ],
        });

        if (offers.length >= 5) return { status: "available", offers };
      }
    }
    return { status: "available", offers };
  } catch (error) {
    console.warn("[product-intelligence] Orosy provider failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "error", offers };
  }
}

export async function runProductIntelligence(
  input: ProductIntelligenceInput,
): Promise<ProductIntelligenceResult> {
  const ids = identifiersFromRecord(marketRecord(input));

  const [cj, orosy] = await Promise.all([
    investigateCJ(input, ids),
    investigateOrosy(input, ids),
  ]);

  const offers = [...cj.offers, ...orosy.offers];
  const confirmed = offers.filter((offer) => offer.identity.confirmed);
  const orderable = confirmed.filter((offer) => offer.orderable);
  const inStock = orderable.filter(
    (offer) => offer.inventory !== null && offer.inventory > 0,
  );

  let reason: ProductIntelligenceResult["sellability"]["reason"] = "no_identity_confirmed_offer";
  if (confirmed.length > 0) reason = "no_orderable_offer";
  if (orderable.length > 0) reason = "no_inventory_confirmed";
  if (inStock.length > 0) reason = "eligible";

  return {
    query: ids,
    market: {
      title: input.title ?? null,
      brand: input.brand ?? null,
      imageUrl: input.imageUrl ?? null,
    },
    offers,
    suppliers: {
      cj: cj.status,
      orosy: orosy.status,
    },
    sellability: {
      eligible: reason === "eligible",
      reason,
    },
  };
}
