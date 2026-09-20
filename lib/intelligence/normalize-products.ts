import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type NormalizeResult = {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
};

type ObservationRow = {
  id: string;
  product_id: string | null;
  source_url: string | null;
  normalized_data: Record<string, unknown> | null;
  raw_data: Record<string, unknown> | null;
  confidence: number | null;
  observed_at: string;
  captured_at: string;
};

type ProductRow = {
  id: string;
  canonical_name: string;
  brand_id: string | null;
};

type BrandRow = {
  id: string;
  name: string;
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const result = value.replace(/\s+/g, " ").trim();

  return result || null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").replace(/[^\d.-]/g, "");
    if (!normalized) return null;

    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function url(value: unknown): string | null {
  const valueText = text(value);

  if (!valueText) return null;

  try {
    const parsed = new URL(valueText);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function calculateIdentityConfidence(
  product: ProductRow,
  brand: BrandRow | null,
  observation: ObservationRow,
): number {
  let score = 0.5;

  if (product.canonical_name.trim()) score += 0.2;
  if (brand?.name) score += 0.15;
  if (observation.source_url) score += 0.1;
  if (observation.confidence !== null) score += 0.05;

  return clamp(score);
}

function calculatePriceConfidence(
  price: number | null,
  currency: string | null,
  sourceUrl: string | null,
): number {
  if (price === null) return 0;

  let score = 0.5;

  if (price >= 0) score += 0.2;
  if (currency) score += 0.15;
  if (sourceUrl) score += 0.15;

  return clamp(score);
}

export async function normalizeProductIntelligence(): Promise<NormalizeResult> {
  const supabase = createSupabaseAdminClient();

  const productsResult = await supabase
    .from("products")
    .select("id, canonical_name, brand_id");

  if (productsResult.error) {
    throw new Error(
      `Failed to load products: ${productsResult.error.message}`,
    );
  }

  const products = (productsResult.data ?? []) as ProductRow[];

  let processed = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    const observationResult = await supabase
      .from("observations")
      .select(
        "id, product_id, source_url, normalized_data, raw_data, confidence, observed_at, captured_at",
      )
      .eq("product_id", product.id)
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (observationResult.error) {
      throw new Error(
        `Failed to load observation for ${product.id}: ${observationResult.error.message}`,
      );
    }

    const observation = observationResult.data as ObservationRow | null;

    if (!observation) {
      skipped += 1;
      continue;
    }

    const brandResult = product.brand_id
      ? await supabase
          .from("brands")
          .select("id, name")
          .eq("id", product.brand_id)
          .maybeSingle()
      : { data: null, error: null };

    if (brandResult.error) {
      throw new Error(
        `Failed to load brand for ${product.id}: ${brandResult.error.message}`,
      );
    }

    const brand = brandResult.data as BrandRow | null;

    const normalized = observation.normalized_data ?? {};
    const raw = observation.raw_data ?? {};

    const normalizedTitle =
      text(normalized.title) ??
      text(raw.title) ??
      product.canonical_name;

    const brandName =
      brand?.name ??
      text(normalized.brand) ??
      text(raw.brand);

    const sellerName =
      text(normalized.seller) ??
      text(raw.seller);

    const sourceUrl =
      url(normalized.sourceUrl) ??
      url(observation.source_url) ??
      url(raw.productUrl);

    const imageUrl =
      url(normalized.imageUrl) ??
      url(raw.imageUrl);

    const currentPrice =
      number(normalized.price) ??
      number(raw.price);

    const currency =
      text(normalized.currency) ??
      (currentPrice !== null ? "USD" : null);

    const identityConfidence = calculateIdentityConfidence(
      product,
      brand,
      observation,
    );

    const priceConfidence = calculatePriceConfidence(
      currentPrice,
      currency,
      sourceUrl,
    );

    const existing = await supabase
      .from("product_intelligence")
      .select(
        "id, demand_signal, supply_signal, trend_signal, opportunity_score, status, metadata",
      )
      .eq("product_id", product.id)
      .maybeSingle();

    if (existing.error) {
      throw new Error(
        `Failed to check intelligence for ${product.id}: ${existing.error.message}`,
      );
    }

    const existingMetadata =
      existing.data?.metadata &&
      typeof existing.data.metadata === "object" &&
      !Array.isArray(existing.data.metadata)
        ? (existing.data.metadata as Record<string, unknown>)
        : {};

    const intelligence = {
      product_id: product.id,
      normalized_title: normalizedTitle,
      brand_name: brandName,
      category: null,
      seller_name: sellerName,
      source_url: sourceUrl,
      image_url: imageUrl,
      currency,
      current_price: currentPrice,
      price_confidence: priceConfidence,
      identity_confidence: identityConfidence,
      demand_signal: existing.data?.demand_signal ?? null,
      supply_signal: existing.data?.supply_signal ?? null,
      trend_signal: existing.data?.trend_signal ?? null,
      opportunity_score: existing.data?.opportunity_score ?? null,
      status: existing.data?.status ?? "candidate",
      metadata: {
        ...existingMetadata,
        observation_id: observation.id,
        source_type: "search",
        provider: "brightdata",
        normalized_at: new Date().toISOString(),
      },
      last_seen_at: observation.observed_at,
      updated_at: new Date().toISOString(),
    };

    const result = await supabase
      .from("product_intelligence")
      .upsert(intelligence, {
        onConflict: "product_id",
      })
      .select("id")
      .single();

    if (result.error) {
      throw new Error(
        `Failed to normalize ${product.canonical_name}: ${result.error.message}`,
      );
    }

    processed += 1;

    if (existing.data) {
      updated += 1;
    } else {
      created += 1;
    }
  }

  return {
    processed,
    created,
    updated,
    skipped,
  };
}
