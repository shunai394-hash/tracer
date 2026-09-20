import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assessDemandRelevance } from "@/lib/intelligence/identity-confidence";

export async function stampDemandCJIdentities(limit = 200): Promise<{
  processed: number;
  rejectedNoise: number;
  unconfirmed: number;
  eligible: number;
}> {
  const supabase = createSupabaseAdminClient();

  const { data: rows, error } = await supabase
    .from("demand_cj_products")
    .select(
      "id, title, sku, image_url, product_type, cj_query, demand_product_candidate_id, identity_status",
    )
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  const candidateIds = [
    ...new Set((rows ?? []).map((row) => row.demand_product_candidate_id)),
  ];

  const { data: candidates, error: candidateError } = await supabase
    .from("demand_product_candidates")
    .select("id, query, category")
    .in("id", candidateIds.length > 0 ? candidateIds : ["00000000-0000-0000-0000-000000000000"]);

  if (candidateError) {
    throw new Error(candidateError.message);
  }

  const candidateById = new Map(
    (candidates ?? []).map((row) => [row.id, row]),
  );

  let processed = 0;
  let rejectedNoise = 0;
  let unconfirmed = 0;
  let eligible = 0;

  for (const row of rows ?? []) {
    const candidate = candidateById.get(row.demand_product_candidate_id);
    if (!candidate) continue;

    const title = String(row.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;

    const relevance = assessDemandRelevance({
      demandQuery: candidate.query,
      demandCategory: candidate.category,
      title,
      category: row.product_type,
      sku: row.sku,
      imageUrl: row.image_url,
      cjQuery: row.cj_query,
    });

    const updatePayload: Record<string, unknown> = {
      identity_confidence: relevance.score,
      identity_status: relevance.status,
      identity_rationale: relevance.rationale,
      identity_metadata: relevance.signals,
      updated_at: new Date().toISOString(),
    };

    if (
      relevance.status === "rejected_noise" ||
      relevance.status === "identity_unconfirmed"
    ) {
      updatePayload.product_id = null;
    }

    const update = await supabase
      .from("demand_cj_products")
      .update(updatePayload)
      .eq("id", row.id);

    if (update.error) {
      throw new Error(update.error.message);
    }

    processed += 1;
    if (relevance.status === "rejected_noise") rejectedNoise += 1;
    else if (relevance.status === "identity_unconfirmed") unconfirmed += 1;
    else eligible += 1;
  }

  return { processed, rejectedNoise, unconfirmed, eligible };
}
