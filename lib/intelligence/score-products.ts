import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

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

function normalizePriceScore(price: number | null): number {
  if (price === null || !Number.isFinite(price) || price <= 0) {
    return 0;
  }

  if (price <= 20) return 100;
  if (price <= 50) return 85;
  if (price <= 100) return 70;
  if (price <= 200) return 55;
  if (price <= 400) return 40;
  return 25;
}

function normalizeSupplyScore(offerCount: number): number {
  if (offerCount <= 0) return 0;
  if (offerCount === 1) return 100;
  if (offerCount === 2) return 85;
  if (offerCount === 3) return 70;
  if (offerCount <= 5) return 55;
  if (offerCount <= 10) return 40;
  return 25;
}

function calculateLegacyOpportunityScore(args: {
  priceScore: number;
  supplyScore: number;
  identityConfidence: number;
  priceConfidence: number;
}): number {
  const confidence =
    ((args.identityConfidence + args.priceConfidence) / 2) * 100;

  return round(
    clamp(
      args.priceScore * 0.35 +
        args.supplyScore * 0.25 +
        confidence * 0.4,
    ) / 100,
    4,
  );
}

function calculateDemandOpportunityScore(args: {
  demandScore: number;
  priceScore: number;
  supplyScore: number;
  identityConfidence: number;
  priceConfidence: number;
}): number {
  const confidence =
    ((args.identityConfidence + args.priceConfidence) / 2) * 100;

  return round(
    clamp(
      args.demandScore * 0.35 +
        args.priceScore * 0.25 +
        args.supplyScore * 0.15 +
        confidence * 0.25,
    ) / 100,
    4,
  );
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

    const priceScore = normalizePriceScore(
      typeof row.current_price === "number"
        ? row.current_price
        : row.current_price !== null
          ? Number(row.current_price)
          : null,
    );

    const supplyScore = normalizeSupplyScore(offerCount);

    const identityConfidence =
      typeof row.identity_confidence === "number"
        ? row.identity_confidence
        : Number(row.identity_confidence ?? 0);

    const priceConfidence =
      typeof row.price_confidence === "number"
        ? row.price_confidence
        : Number(row.price_confidence ?? 0);

    const demandSignal =
      typeof row.demand_signal === "number"
        ? row.demand_signal
        : row.demand_signal !== null
          ? Number(row.demand_signal)
          : null;

    const opportunityScore =
      demandSignal !== null && Number.isFinite(demandSignal)
        ? calculateDemandOpportunityScore({
            demandScore: clamp(demandSignal) * 100,
            priceScore,
            supplyScore,
            identityConfidence: clamp(identityConfidence, 0, 1),
            priceConfidence: clamp(priceConfidence, 0, 1),
          })
        : calculateLegacyOpportunityScore({
            priceScore,
            supplyScore,
            identityConfidence: clamp(identityConfidence, 0, 1),
            priceConfidence: clamp(priceConfidence, 0, 1),
          });

    const existingMetadata =
      row.metadata &&
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};

    const { error: updateError } = await supabase
      .from("product_intelligence")
      .update({
        supply_signal: round(supplyScore / 100),
        opportunity_score: opportunityScore,
        metadata: {
          ...existingMetadata,
          offer_count: offerCount,
          price_score: round(priceScore / 100),
          supply_score: round(supplyScore / 100),
          demand_score:
            demandSignal !== null && Number.isFinite(demandSignal)
              ? round(clamp(demandSignal))
              : existingMetadata.demand_score ?? null,
          scoring_version:
            demandSignal !== null && Number.isFinite(demandSignal)
              ? "v2"
              : "v1",
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
