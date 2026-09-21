import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { scoreFromKnown } from "@/lib/intelligence/sellability";

type ScoreResult = {
  processed: number;
  updated: number;
  skipped: number;
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
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return null;
  }

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

export async function scoreProductIntelligence(): Promise<ScoreResult> {
  const supabase = createSupabaseAdminClient();

  const { data: intelligenceRows, error: intelligenceError } =
    await supabase
      .from("product_intelligence")
      .select(`
        product_id,
        current_price,
        demand_signal,
        identity_confidence,
        price_confidence,
        metadata
      `);

  if (intelligenceError) {
    throw new Error(intelligenceError.message);
  }

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of intelligenceRows ?? []) {
    processed += 1;

    const { count, error: offerError } = await supabase
      .from("product_offers")
      .select("id", { count: "exact", head: true })
      .eq("product_id", row.product_id);

    if (offerError) {
      throw new Error(offerError.message);
    }

    const offerCount = count ?? 0;

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
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};

    const { error: updateError } = await supabase
      .from("product_intelligence")
      .update({
        supply_signal:
          supplyScore === null ? null : round(supplyScore / 100),
        opportunity_score:
          scored.score === null ? null : round(scored.score / 100),
        metadata: {
          ...existingMetadata,
          offer_count: offerCount,
          price_score: priceScore === null ? null : round(priceScore / 100),
          supply_score: supplyScore === null ? null : round(supplyScore / 100),
          demand_score:
            demandSignal === null ? null : round(clamp(demandSignal)),
          identity_score:
            identityConfidence === null
              ? null
              : round(clamp(identityConfidence, 0, 1)),
          scoring_version: "v3_selection",
          unknown_not_zero: true,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("product_id", row.product_id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    updated += 1;
  }

  return {
    processed,
    updated,
    skipped,
  };
}
