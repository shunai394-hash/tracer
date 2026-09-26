import "server-only";

import {
  type ECPulsePriceChangedEvent,
  type ECPulseProduct,
} from "@/lib/sources/ec-pulse";
import { normalizeIdentifier } from "@/lib/market/identifiers";
import { assessCurrencyConfidence } from "@/lib/intelligence/currency-confidence";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const SOURCE_NAME = "EC-Pulse";
const SOURCE_TYPE = "marketplace";
const PROVIDER = "ec-pulse";

type PersistProductResult = {
  sourceId: string;
  productId: string;
  observationId: string;
  offerId: string;
  gtin: string | null;
  price: number | null;
  currency: string | null;
};

type PersistPriceChangeResult = {
  productId: string;
  observationId: string;
  offerId: string | null;
  oldPrice: number;
  newPrice: number;
  currency: string | null;
};

function validHttpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error();
    }
    return parsed.toString();
  } catch {
    throw new Error("EC-Pulse source URL must be an http(s) URL");
  }
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parsePrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function normalizeGtin(value: string | null): string | null {
  return normalizeIdentifier("gtin", value);
}

function identityKey(gtin: string | null, sourceUrl: string): string {
  return gtin ? `gtin::${gtin}` : `ec-pulse-url::${sourceUrl}`;
}

async function getOrCreateSource() {
  const supabase = createSupabaseAdminClient();

  const existing = await supabase
    .from("sources")
    .select("id")
    .eq("name", SOURCE_NAME)
    .maybeSingle();

  if (existing.error) {
    throw new Error(`Failed to find EC-Pulse source: ${existing.error.message}`);
  }

  if (existing.data) return existing.data.id;

  const created = await supabase
    .from("sources")
    .insert({
      name: SOURCE_NAME,
      source_type: SOURCE_TYPE,
      base_url: "https://ec-pulse-api.vercel.app",
      provider: PROVIDER,
    })
    .select("id")
    .single();

  if (created.error) {
    throw new Error(`Failed to create EC-Pulse source: ${created.error.message}`);
  }

  return created.data.id;
}

async function getOrCreateBrand(name: string | null): Promise<string | null> {
  if (!name?.trim()) return null;

  const supabase = createSupabaseAdminClient();
  const normalized = name.trim();

  const existing = await supabase
    .from("brands")
    .select("id")
    .eq("name", normalized)
    .maybeSingle();

  if (existing.error) {
    throw new Error(`Failed to find EC-Pulse brand: ${existing.error.message}`);
  }

  if (existing.data) return existing.data.id;

  const created = await supabase
    .from("brands")
    .insert({ name: normalized })
    .select("id")
    .single();

  if (created.error) {
    throw new Error(`Failed to create EC-Pulse brand: ${created.error.message}`);
  }

  return created.data.id;
}

export async function persistECPulseProduct(
  payload: ECPulseProduct,
): Promise<PersistProductResult> {
  const supabase = createSupabaseAdminClient();
  const sourceId = await getOrCreateSource();

  const title = normalizeTitle(payload.product.title);
  if (!title) throw new Error("EC-Pulse product title is empty");

  const sourceUrl = validHttpUrl(payload.source.url);
  const imageUrl = payload.source.image
    ? validHttpUrl(payload.source.image)
    : null;
  const gtin = normalizeGtin(payload.product.gtin);
  const price = parsePrice(payload.pricing.price);
  const currency = payload.pricing.currency?.trim().toUpperCase() || null;
  const brandId = await getOrCreateBrand(payload.product.brand);
  const key = identityKey(gtin, sourceUrl);

  let productId: string | null = null;

  const byIdentity = await supabase
    .from("products")
    .select("id")
    .eq("identity_key", key)
    .maybeSingle();

  if (byIdentity.error) {
    throw new Error(`Failed to find EC-Pulse product: ${byIdentity.error.message}`);
  }

  if (byIdentity.data) {
    productId = byIdentity.data.id;
  } else {
    const created = await supabase
      .from("products")
      .insert({
        brand_id: brandId,
        canonical_name: title,
        identity_key: key,
      })
      .select("id")
      .single();

    if (created.error) {
      throw new Error(`Failed to create EC-Pulse product: ${created.error.message}`);
    }

    productId = created.data.id;
  }

  const capturedAt = new Date(payload.captured_at).toISOString();

  const observation = await supabase
    .from("observations")
    .insert({
      product_id: productId,
      source_id: sourceId,
      source_url: sourceUrl,
      source_type: SOURCE_TYPE,
      observed_at: capturedAt,
      captured_at: capturedAt,
      raw_data: payload,
      normalized_data: {
        title,
        brand: payload.product.brand,
        model: payload.product.model,
        sku: payload.product.sku,
        gtin,
        price,
        currency,
        availability: payload.availability.status,
        ratingScore: payload.rating.score,
        ratingCount: payload.rating.count,
        seller: payload.seller.name,
        sourceUrl,
        imageUrl,
        provider: PROVIDER,
      },
      confidence: gtin ? 0.98 : 0.8,
    })
    .select("id")
    .single();

  if (observation.error) {
    throw new Error(`Failed to create EC-Pulse observation: ${observation.error.message}`);
  }

  if (price !== null && currency) {
    const priceResult = await supabase.from("price_observations").insert({
      id: observation.data.id,
      currency,
      amount: price,
    });

    if (priceResult.error) {
      throw new Error(`Failed to create EC-Pulse price observation: ${priceResult.error.message}`);
    }
  }

  const currencyAssessment = assessCurrencyConfidence({
    currency,
    price,
    provider: PROVIDER,
  });

  const offer = await supabase
    .from("product_offers")
    .upsert(
      {
        product_id: productId,
        seller_name: payload.seller.name,
        offer_url: sourceUrl,
        image_url: imageUrl,
        currency,
        price,
        currency_confidence: currencyAssessment.confidence,
        availability: payload.availability.status,
        shipping_price: null,
        observed_at: capturedAt,
        metadata: {
          provider: PROVIDER,
          source_id: sourceId,
          observation_id: observation.data.id,
          model: payload.product.model,
          sku: payload.product.sku,
          gtin,
          rating_score: payload.rating.score,
          rating_count: payload.rating.count,
          source_site: payload.source.site,
        },
      },
      { onConflict: "product_id,offer_url" },
    )
    .select("id")
    .single();

  if (offer.error) {
    throw new Error(`Failed to upsert EC-Pulse offer: ${offer.error.message}`);
  }

  await supabase.from("product_intelligence").upsert(
    {
      product_id: productId,
      normalized_title: title,
      brand_name: payload.product.brand,
      seller_name: payload.seller.name,
      source_url: sourceUrl,
      image_url: imageUrl,
      currency,
      current_price: price,
      price_confidence: price !== null && currency ? 0.95 : 0,
      identity_confidence: gtin ? 0.98 : 0.75,
      metadata: {
        provider: PROVIDER,
        source_id: sourceId,
        observation_id: observation.data.id,
        identifiers: {
          gtin,
          sku: payload.product.sku,
          model: payload.product.model,
        },
        availability: payload.availability.status,
        source_site: payload.source.site,
      },
      last_seen_at: capturedAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "product_id" },
  );

  return {
    sourceId,
    productId,
    observationId: observation.data.id,
    offerId: offer.data.id,
    gtin,
    price,
    currency,
  };
}

export async function persistECPulsePriceChange(
  event: ECPulsePriceChangedEvent,
): Promise<PersistPriceChangeResult> {
  const supabase = createSupabaseAdminClient();
  const sourceId = await getOrCreateSource();
  const sourceUrl = validHttpUrl(event.url);
  const currency = event.currency?.trim().toUpperCase() || null;
  const capturedAt = new Date(event.captured_at).toISOString();

  const offerResult = await supabase
    .from("product_offers")
    .select("id, product_id, price, currency, metadata")
    .eq("offer_url", sourceUrl)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (offerResult.error) {
    throw new Error(`Failed to find EC-Pulse offer: ${offerResult.error.message}`);
  }

  let productId = offerResult.data?.product_id ?? null;

  if (!productId) {
    const productResult = await supabase
      .from("products")
      .select("id")
      .eq("identity_key", `ec-pulse-url::${sourceUrl}`)
      .maybeSingle();

    if (productResult.error) {
      throw new Error(`Failed to find EC-Pulse product: ${productResult.error.message}`);
    }

    productId = productResult.data?.id ?? null;
  }

  if (!productId) {
    throw new Error("EC-Pulse price change does not map to a TRACER product");
  }

  const observation = await supabase
    .from("observations")
    .insert({
      product_id: productId,
      source_id: sourceId,
      source_url: sourceUrl,
      source_type: SOURCE_TYPE,
      observed_at: capturedAt,
      captured_at: capturedAt,
      raw_data: event,
      normalized_data: {
        price: event.new_price,
        previousPrice: event.old_price,
        currency,
        source: event.source ?? null,
        provider: PROVIDER,
      },
      confidence: 0.98,
    })
    .select("id")
    .single();

  if (observation.error) {
    throw new Error(`Failed to create EC-Pulse price-change observation: ${observation.error.message}`);
  }

  if (currency) {
    const priceResult = await supabase.from("price_observations").insert({
      id: observation.data.id,
      currency,
      amount: event.new_price,
    });

    if (priceResult.error) {
      throw new Error(`Failed to create EC-Pulse price-change price observation: ${priceResult.error.message}`);
    }
  }

  const offerUpdate = await supabase
    .from("product_offers")
    .update({
      price: event.new_price,
      currency: currency ?? offerResult.data?.currency ?? null,
      observed_at: capturedAt,
      metadata: {
        ...((offerResult.data?.metadata ?? {}) as Record<string, unknown>),
        provider: PROVIDER,
        last_price_change: {
          monitor_id: event.monitor_id,
          old_price: event.old_price,
          new_price: event.new_price,
          captured_at: capturedAt,
        },
        source: event.source ?? null,
      },
    })
    .eq("id", offerResult.data?.id ?? "");

  if (offerUpdate.error) {
    throw new Error(`Failed to update EC-Pulse offer: ${offerUpdate.error.message}`);
  }

  await supabase
    .from("product_intelligence")
    .update({
      current_price: event.new_price,
      currency: currency ?? offerResult.data?.currency ?? null,
      last_seen_at: capturedAt,
      updated_at: new Date().toISOString(),
    })
    .eq("product_id", productId);

  return {
    productId,
    observationId: observation.data.id,
    offerId: offerResult.data?.id ?? null,
    oldPrice: event.old_price,
    newPrice: event.new_price,
    currency,
  };
}
