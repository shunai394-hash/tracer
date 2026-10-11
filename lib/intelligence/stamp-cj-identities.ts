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

  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)));
  const { count: totalCount, error: countError } = await supabase
    .from("demand_cj_products")
    .select("id", { count: "exact", head: true });
  if (countError) throw new Error(countError.message);

  // Rotate through the full backlog. A fixed oldest-first limit reprocessed
  // the same rows forever and starved newer demand candidates.
  const pageCount = Math.max(1, Math.ceil((totalCount ?? 0) / safeLimit));
  const page = Math.floor(Date.now() / (15 * 60_000)) % pageCount;
  const offset = page * safeLimit;
  const { data: rows, error } = await supabase
    .from("demand_cj_products")
    .select(
      "id, title, sku, image_url, product_type, cj_query, demand_product_candidate_id, identity_status",
    )
    .order("created_at", { ascending: true })
    .range(offset, offset + safeLimit - 1);
  if (error) throw new Error(error.message);
  if (!rows?.length) return { processed: 0, rejectedNoise: 0, unconfirmed: 0, eligible: 0 };

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

  const pendingUpdates: Array<{
    id: string;
    payload: Record<string, unknown>;
    status: string;
  }> = [];

  for (const row of rows) {
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

    pendingUpdates.push({
      id: String(row.id),
      payload: updatePayload,
      status: relevance.status,
    });
  }

  let processed = 0;
  let rejectedNoise = 0;
  let unconfirmed = 0;
  let eligible = 0;

  // Update a small bounded set concurrently rather than serializing one
  // network round trip per row. Every update is idempotent; a failed batch is
  // retried by the next patrol without relaxing identity criteria.
  for (let offset = 0; offset < pendingUpdates.length; offset += 20) {
    const batch = pendingUpdates.slice(offset, offset + 20);
    const results = await Promise.all(
      batch.map((item) =>
        supabase
          .from("demand_cj_products")
          .update(item.payload)
          .eq("id", item.id),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) throw new Error(failed.error.message);

    processed += batch.length;
    for (const item of batch) {
      if (item.status === "rejected_noise") rejectedNoise += 1;
      else if (item.status === "identity_unconfirmed") unconfirmed += 1;
      else eligible += 1;
    }
  }

  return { processed, rejectedNoise, unconfirmed, eligible };
}
