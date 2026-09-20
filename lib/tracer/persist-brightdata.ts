import "server-only";

import type { BrightDataProductCandidate } from "@/lib/sources/brightdata/client";
import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const SOURCE_NAME = "Google Shopping";
const SOURCE_TYPE = "search";
const PROVIDER = "brightdata";

type PersistResult = {
  sourceId: string;
  productsCreated: number;
  productsReused: number;
  observationsCreated: number;
  pricesCreated: number;
  offersCreated: number;
};

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildIdentityKey(brandName: string | null, title: string): string {
  const brand = normalizeIdentityText(brandName ?? "");
  const normalizedTitle = normalizeIdentityText(title);

  return `${brand}::${normalizedTitle}`;
}

function parsePrice(value: string | null): number | null {
  if (!value) return null;

  const normalized = value
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "");

  if (!normalized) return null;

  const amount = Number(normalized);

  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function validHttpUrl(value: string | null): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function inferBrand(title: string): string | null {
  const first = normalizeTitle(title).split(" ")[0]?.trim();

  return first || null;
}

export async function persistBrightDataProducts(
  query: string,
  candidates: BrightDataProductCandidate[],
): Promise<PersistResult> {
  const supabase = createSupabaseAdminClient();

  const existingSource = await supabase
    .from("sources")
    .select("id")
    .eq("name", SOURCE_NAME)
    .maybeSingle();

  if (existingSource.error) {
    throw new Error(
      `Failed to find source: ${existingSource.error.message}`,
    );
  }

  let sourceId: string;

  if (existingSource.data) {
    sourceId = existingSource.data.id;
  } else {
    const sourceResult = await supabase
      .from("sources")
      .insert({
        name: SOURCE_NAME,
        source_type: SOURCE_TYPE,
        base_url: "https://www.google.com/shopping",
        provider: PROVIDER,
      })
      .select("id")
      .single();

    if (sourceResult.error) {
      throw new Error(
        `Failed to insert source: ${sourceResult.error.message}`,
      );
    }

    sourceId = sourceResult.data.id;
  }

  let productsCreated = 0;
  let productsReused = 0;
  let observationsCreated = 0;
  let pricesCreated = 0;
  let offersCreated = 0;

  for (const candidate of candidates) {
    const canonicalName = normalizeTitle(candidate.title);

    if (!canonicalName) continue;

    const brandName = inferBrand(canonicalName);
    const identityKey = buildIdentityKey(brandName, canonicalName);

    let brandId: string | null = null;

    if (brandName) {
      const existingBrand = await supabase
        .from("brands")
        .select("id")
        .eq("name", brandName)
        .maybeSingle();

      if (existingBrand.error) {
        throw new Error(
          `Failed to find brand "${brandName}": ${existingBrand.error.message}`,
        );
      }

      if (existingBrand.data) {
        brandId = existingBrand.data.id;
      } else {
        const brandResult = await supabase
          .from("brands")
          .insert({ name: brandName })
          .select("id")
          .single();

        if (brandResult.error) {
          throw new Error(
            `Failed to insert brand "${brandName}": ${brandResult.error.message}`,
          );
        }

        brandId = brandResult.data.id;
      }
    }

    let productId: string | null = null;

    /*
     * 1. identity_keyで既存商品を検索
     */
    const identityProduct = await supabase
      .from("products")
      .select("id, canonical_name")
      .eq("identity_key", identityKey)
      .maybeSingle();

    if (identityProduct.error) {
      throw new Error(
        `Failed to find product by identity "${identityKey}": ${identityProduct.error.message}`,
      );
    }

    if (identityProduct.data) {
      productId = identityProduct.data.id;
      productsReused += 1;
    }

    /*
     * 2. identity_keyがまだ付いていない既存商品を
     *    canonical_name完全一致で救済
     */
    if (!productId) {
      const existingProduct = await supabase
        .from("products")
        .select("id, identity_key")
        .eq("canonical_name", canonicalName)
        .maybeSingle();

      if (existingProduct.error) {
        throw new Error(
          `Failed to find product "${canonicalName}": ${existingProduct.error.message}`,
        );
      }

      if (existingProduct.data) {
        productId = existingProduct.data.id;
        productsReused += 1;

        /*
         * 既存商品へidentity_keyをバックフィル
         */
        if (!existingProduct.data.identity_key) {
          const identityUpdate = await supabase
            .from("products")
            .update({
              identity_key: identityKey,
            })
            .eq("id", productId);

          if (identityUpdate.error) {
            throw new Error(
              `Failed to backfill identity for "${canonicalName}": ${identityUpdate.error.message}`,
            );
          }
        }
      }
    }

    /*
     * 3. 完全新規商品
     */
    if (!productId) {
      const productResult = await supabase
        .from("products")
        .insert({
          brand_id: brandId,
          canonical_name: canonicalName,
          identity_key: identityKey,
        })
        .select("id")
        .single();

      if (productResult.error) {
        throw new Error(
          `Failed to insert product "${canonicalName}": ${productResult.error.message}`,
        );
      }

      productId = productResult.data.id;
      productsCreated += 1;
    }

    const sourceUrl = validHttpUrl(candidate.productUrl);
    const imageUrl = validHttpUrl(candidate.imageUrl);
    const amount = parsePrice(candidate.price);

    const observationResult = await supabase
      .from("observations")
      .insert({
        product_id: productId,
        source_id: sourceId,
        source_url: sourceUrl,
        source_type: SOURCE_TYPE,
        raw_data: {
          query,
          title: candidate.title,
          price: candidate.price,
          seller: candidate.seller,
          productUrl: candidate.productUrl,
          imageUrl: candidate.imageUrl,
        },
        normalized_data: {
          title: canonicalName,
          seller: candidate.seller,
          sourceUrl,
          imageUrl,
          price: amount,
          currency: amount !== null ? "USD" : null,
        },
        confidence: 0.8,
      })
      .select("id")
      .single();

    if (observationResult.error) {
      throw new Error(
        `Failed to insert observation for "${canonicalName}": ${observationResult.error.message}`,
      );
    }

    observationsCreated += 1;

    if (amount !== null) {
      const priceResult = await supabase
        .from("price_observations")
        .insert({
          id: observationResult.data.id,
          currency: "USD",
          amount,
        });

      if (priceResult.error) {
        throw new Error(
          `Failed to insert price for "${canonicalName}": ${priceResult.error.message}`,
        );
      }

      pricesCreated += 1;
    }

    const currency = amount !== null ? "USD" : null;
    const currencyAssessment = assessCurrencyConfidence({
      currency,
      price: amount,
      provider: PROVIDER,
    });

    const offerResult = await supabase
      .from("product_offers")
      .insert({
        product_id: productId,
        seller_name: candidate.seller,
        offer_url: sourceUrl,
        image_url: imageUrl,
        currency,
        price: amount,
        currency_confidence: currencyAssessment.confidence,
        availability: null,
        shipping_price: null,
        observed_at: new Date().toISOString(),
        metadata: {
          query,
          provider: PROVIDER,
          source_id: sourceId,
          observation_id: observationResult.data.id,
          currency_confidence: currencyAssessment.confidence,
          currency_confidence_reasons: currencyAssessment.reasons,
        },
      })
      .select("id")
      .single();

    if (offerResult.error) {
      throw new Error(
        `Failed to insert offer for "${canonicalName}": ${offerResult.error.message}`,
      );
    }

    offersCreated += 1;
  }

  return {
    sourceId,
    productsCreated,
    productsReused,
    observationsCreated,
    pricesCreated,
    offersCreated,
  };
}
