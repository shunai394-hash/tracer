import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { scoreFromKnown } from "@/lib/intelligence/sellability";

type ScoreResult = {
  processed: number;
  updated: number;
  skipped: number;
};

type IntelligenceRow = {
  product_id: string;
  current_price: number | string | null;
  demand_signal: number | string | null;
  identity_confidence: number | string | null;
  price_confidence: number | string | null;
  metadata: Record<string, unknown> | null;
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePriceScore(price: number | null): number | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  if (price <= 20) return 100;
  if (price <= 50) return 85;
  if (price <= 100) return 70;
  if (price <= 200) return 55;
  if (price <= 400) return 40;
  return 25;
}

function normalizeSupplyScore(offerCount: number): number | null {
  if (offerCount <= 0) return null;
  if (offerCount === 1) return 100;
  if (offerCount === 2) return 85;
  if (offerCount === 3) return 70;
  if (offerCount <= 5) return 55;
  if (offerCount <= 10) return 40;
  return 25;
}

const SCORE_BATCH_SIZE = 100;
const OFFER_PAGE_SIZE = 1000;
const MAX_OFFER_ROWS_PER_BATCH = 20_000;
const UPDATE_CONCURRENCY = 10;

/**
 * Score a rotating, bounded product-intelligence page. The former full-catalog
 * loop issued one COUNT query and one UPDATE per product, so ~1,500 products
 * routinely consumed the patrol budget before sales-test selection could run.
 * Offer counts are now read in pages for the active product IDs, then updates
 * run in small bounded groups. No unknown offer count is treated as zero.
 */
export async function scoreProductIntelligence(): Promise<ScoreResult> {
  const supabase = createSupabaseAdminClient();

  const countResult = await supabase
    .from("product_intelligence")
    .select("product_id", { count: "exact", head: true });
  if (countResult.error) throw new Error(countResult.error.message);

  const totalRows = countResult.count ?? 0;
  const pages = Math.max(1, Math.ceil(totalRows / SCORE_BATCH_SIZE));
  const page = Math.floor(Date.now() / (15 * 60_000)) % pages;
  const offset = page * SCORE_BATCH_SIZE;

  const intelligenceResult = await supabase
    .from("product_intelligence")
    .select("product_id,current_price,demand_signal,identity_confidence,price_confidence,metadata")
    .order("product_id", { ascending: true })
    .range(offset, offset + SCORE_BATCH_SIZE - 1);
  if (intelligenceResult.error) throw new Error(intelligenceResult.error.message);

  const intelligenceRows = (intelligenceResult.data ?? []) as IntelligenceRow[];
  if (intelligenceRows.length === 0) return { processed: 0, updated: 0, skipped: 0 };

  const productIds = intelligenceRows.map((row) => String(row.product_id));
  const offerCounts = new Map<string, number>();

  // Page the offer rows rather than issuing a COUNT query for every product.
  // If the active page exceeds the safety cap, fail rather than silently score
  // from a truncated offer set.
  let offerOffset = 0;
  while (true) {
    const offerResult = await supabase
      .from("product_offers")
      .select("id,product_id")
      .in("product_id", productIds)
      .order("id", { ascending: true })
      .range(offerOffset, offerOffset + OFFER_PAGE_SIZE - 1);

    if (offerResult.error) throw new Error(offerResult.error.message);
    const offerRows = offerResult.data ?? [];
    for (const offer of offerRows) {
      const productId = String(offer.product_id ?? "");
      if (productId) offerCounts.set(productId, (offerCounts.get(productId) ?? 0) + 1);
    }

    if (offerRows.length < OFFER_PAGE_SIZE) break;
    offerOffset += OFFER_PAGE_SIZE;
    if (offerOffset >= MAX_OFFER_ROWS_PER_BATCH) {
      throw new Error("product_offers_batch_limit_exceeded: scoring deferred to preserve exact offer counts");
    }
  }

  const updates: Array<{ productId: string; payload: Record<string, unknown> }> = [];
  let skipped = 0;

  for (const row of intelligenceRows) {
    const productId = String(row.product_id);
    const offerCount = offerCounts.get(productId) ?? 0;
    if (offerCount === 0) {
      skipped += 1;
      continue;
    }

    const priceScore = normalizePriceScore(asNumber(row.current_price));
    const supplyScore = normalizeSupplyScore(offerCount);
    const identityConfidence = asNumber(row.identity_confidence);
    const priceConfidence = asNumber(row.price_confidence);
    const demandSignal = asNumber(row.demand_signal);

    const scored = scoreFromKnown([
      {
        score: demandSignal === null ? null : clamp(demandSignal) * 100,
        weight: 0.28,
        confidence: demandSignal === null ? 0 : 0.7,
      },
      {
        score: identityConfidence === null ? null : clamp(identityConfidence, 0, 1) * 100,
        weight: 0.18,
        confidence: identityConfidence === null ? 0 : 0.75,
      },
      {
        score: priceScore,
        weight: 0.18,
        confidence: priceScore === null ? 0 : priceConfidence ?? 0.5,
      },
      {
        score: supplyScore,
        weight: 0.16,
        confidence: supplyScore === null ? 0 : 0.7,
      },
      {
        score: priceConfidence === null ? null : clamp(priceConfidence, 0, 1) * 100,
        weight: 0.2,
        confidence: priceConfidence === null ? 0 : 0.6,
      },
    ]);

    const existingMetadata =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? row.metadata
        : {};

    updates.push({
      productId,
      payload: {
        supply_signal: supplyScore === null ? null : round(supplyScore / 100),
        opportunity_score: scored.score === null ? null : round(scored.score / 100),
        metadata: {
          ...existingMetadata,
          offer_count: offerCount,
          price_score: priceScore === null ? null : round(priceScore / 100),
          supply_score: supplyScore === null ? null : round(supplyScore / 100),
          demand_score: demandSignal === null ? null : round(clamp(demandSignal)),
          identity_score: identityConfidence === null ? null : round(clamp(identityConfidence, 0, 1)),
          scoring_version: "v3_selection",
          unknown_not_zero: true,
        },
        updated_at: new Date().toISOString(),
      },
    });
  }

  let updated = 0;
  for (let start = 0; start < updates.length; start += UPDATE_CONCURRENCY) {
    const batch = updates.slice(start, start + UPDATE_CONCURRENCY);
    const results = await Promise.all(batch.map(({ productId, payload }) =>
      supabase.from("product_intelligence").update(payload).eq("product_id", productId),
    ));
    const failed = results.find((result) => result.error);
    if (failed?.error) throw new Error(failed.error.message);
    updated += batch.length;
  }

  return { processed: intelligenceRows.length, updated, skipped };
}
