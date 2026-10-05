import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type NormalizeResult = { processed: number; created: number; updated: number; skipped: number };
type ProductRow = { id: string; canonical_name: string; brand_id: string | null };
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
type BrandRow = { id: string; name: string };
type IntelligenceRow = {
  product_id: string;
  demand_signal: number | null;
  supply_signal: number | null;
  trend_signal: number | null;
  opportunity_score: number | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/\s+/g, " ").trim();
  return result || null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function url(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  try {
    const parsed = new URL(valueText);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

function identityConfidence(product: ProductRow, brand: BrandRow | null, observation: ObservationRow): number {
  let score = 0.5;
  if (product.canonical_name.trim()) score += 0.2;
  if (brand?.name) score += 0.15;
  if (observation.source_url) score += 0.1;
  if (observation.confidence !== null) score += 0.05;
  return clamp(score);
}

function priceConfidence(price: number | null, currency: string | null, sourceUrl: string | null): number {
  if (price === null) return 0;
  let score = 0.5;
  if (price >= 0) score += 0.2;
  if (currency) score += 0.15;
  if (sourceUrl) score += 0.15;
  return clamp(score);
}

const CHUNK = 100;

/**
 * Batch implementation of normalization. The previous implementation did
 * product -> observation -> brand -> intelligence -> upsert sequentially,
 * producing thousands of round trips and routinely exhausting the 5s patrol
 * budget before downstream identity/supply/gates could run.
 */
export async function normalizeProductIntelligence(): Promise<NormalizeResult> {
  const supabase = createSupabaseAdminClient();

  const productsResult = await supabase.from("products").select("id, canonical_name, brand_id");
  if (productsResult.error) throw new Error(`Failed to load products: ${productsResult.error.message}`);
  const products = (productsResult.data ?? []) as ProductRow[];
  if (products.length === 0) return { processed: 0, created: 0, updated: 0, skipped: 0 };

  const productIds = products.map((product) => product.id);
  const observationMap = new Map<string, ObservationRow>();
  for (let offset = 0; offset < productIds.length; offset += 500) {
    const ids = productIds.slice(offset, offset + 500);
    const result = await supabase
      .from("observations")
      .select("id,product_id,source_url,normalized_data,raw_data,confidence,observed_at,captured_at")
      .in("product_id", ids)
      .order("observed_at", { ascending: false })
      .limit(5000);
    if (result.error) throw new Error(`Failed to load observations: ${result.error.message}`);
    for (const row of (result.data ?? []) as ObservationRow[]) {
      if (row.product_id && !observationMap.has(row.product_id)) observationMap.set(row.product_id, row);
    }
  }

  const brandIds = Array.from(new Set(products.map((product) => product.brand_id).filter((id): id is string => Boolean(id))));
  const brands = new Map<string, BrandRow>();
  for (let offset = 0; offset < brandIds.length; offset += 500) {
    const result = await supabase.from("brands").select("id,name").in("id", brandIds.slice(offset, offset + 500));
    if (result.error) throw new Error(`Failed to load brands: ${result.error.message}`);
    for (const row of (result.data ?? []) as BrandRow[]) brands.set(row.id, row);
  }

  const existing = new Map<string, IntelligenceRow>();
  for (let offset = 0; offset < productIds.length; offset += 500) {
    const result = await supabase
      .from("product_intelligence")
      .select("product_id,demand_signal,supply_signal,trend_signal,opportunity_score,status,metadata")
      .in("product_id", productIds.slice(offset, offset + 500));
    if (result.error) throw new Error(`Failed to load intelligence: ${result.error.message}`);
    for (const row of (result.data ?? []) as IntelligenceRow[]) existing.set(String(row.product_id), row);
  }

  const now = new Date().toISOString();
  const payloads: Record<string, unknown>[] = [];
  let skipped = 0;
  let created = 0;
  let updated = 0;

  for (const product of products) {
    const observation = observationMap.get(product.id);
    if (!observation) { skipped += 1; continue; }

    const normalized = observation.normalized_data ?? {};
    const raw = observation.raw_data ?? {};
    const brand = product.brand_id ? brands.get(product.brand_id) ?? null : null;
    const normalizedTitle = text(normalized.title) ?? text(raw.title) ?? product.canonical_name;
    const brandName = brand?.name ?? text(normalized.brand) ?? text(raw.brand);
    const sellerName = text(normalized.seller) ?? text(raw.seller);
    const sourceUrl = url(normalized.sourceUrl) ?? url(observation.source_url) ?? url(raw.productUrl);
    const imageUrl = url(normalized.imageUrl) ?? url(raw.imageUrl);
    const currentPrice = number(normalized.price) ?? number(raw.price);
    const currency = text(normalized.currency) ?? (currentPrice !== null ? "USD" : null);
    const previous = existing.get(product.id);
    const previousMetadata = previous?.metadata && typeof previous.metadata === "object" && !Array.isArray(previous.metadata) ? previous.metadata : {};

    payloads.push({
      product_id: product.id,
      normalized_title: normalizedTitle,
      brand_name: brandName,
      category: null,
      seller_name: sellerName,
      source_url: sourceUrl,
      image_url: imageUrl,
      currency,
      current_price: currentPrice,
      price_confidence: priceConfidence(currentPrice, currency, sourceUrl),
      identity_confidence: identityConfidence(product, brand, observation),
      demand_signal: previous?.demand_signal ?? null,
      supply_signal: previous?.supply_signal ?? null,
      trend_signal: previous?.trend_signal ?? null,
      opportunity_score: previous?.opportunity_score ?? null,
      status: previous?.status ?? "candidate",
      metadata: {
        ...previousMetadata,
        observation_id: observation.id,
        source_type: "search",
        provider: "brightdata",
        normalized_at: now,
      },
      last_seen_at: observation.observed_at,
      updated_at: now,
    });
    if (previous) updated += 1; else created += 1;
  }

  for (let offset = 0; offset < payloads.length; offset += CHUNK) {
    const result = await supabase.from("product_intelligence").upsert(payloads.slice(offset, offset + CHUNK), { onConflict: "product_id" });
    if (result.error) throw new Error(`Failed to normalize product intelligence batch: ${result.error.message}`);
  }

  return { processed: payloads.length, created, updated, skipped };
}
