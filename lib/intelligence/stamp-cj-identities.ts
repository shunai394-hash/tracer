import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { assessDemandRelevance, type IdentityStatus } from "@/lib/intelligence/identity-confidence";

type PendingIdentityUpdate = {
  id: string;
  payload: Record<string, unknown>;
  status: IdentityStatus;
};

const IDENTITY_BATCH_SIZE = 100;
const IDENTITY_UPDATE_CONCURRENCY = 10;

export async function stampDemandCJIdentities(limit = IDENTITY_BATCH_SIZE): Promise<{
  processed: number;
  rejectedNoise: number;
  unconfirmed: number;
  eligible: number;
}> {
  const supabase = createSupabaseAdminClient();
  const batchSize = Math.max(1, Math.min(limit, 200));

  const countResult = await supabase
    .from("demand_cj_products")
    .select("id", { count: "exact", head: true });
  if (countResult.error) throw new Error(countResult.error.message);

  const total = countResult.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / batchSize));
  const page = Math.floor(Date.now() / (15 * 60_000)) % pages;
  const offset = page * batchSize;

  const rowsResult = await supabase
    .from("demand_cj_products")
    .select("id, title, sku, image_url, product_type, cj_query, demand_product_candidate_id, identity_status")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + batchSize - 1);
  if (rowsResult.error) throw new Error(rowsResult.error.message);

  const rows = rowsResult.data ?? [];
  if (rows.length === 0) return { processed: 0, rejectedNoise: 0, unconfirmed: 0, eligible: 0 };

  const candidateIds = [...new Set(
    rows
      .map((row) => row.demand_product_candidate_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  )];

  let candidates: Array<{ id: string; query: string; category: string | null }> = [];
  if (candidateIds.length > 0) {
    const candidateResult = await supabase
      .from("demand_product_candidates")
      .select("id, query, category")
      .in("id", candidateIds);
    if (candidateResult.error) throw new Error(candidateResult.error.message);
    candidates = candidateResult.data ?? [];
  }

  const candidateById = new Map(candidates.map((row) => [row.id, row]));
  const pending: PendingIdentityUpdate[] = [];

  for (const row of rows) {
    const candidateId = typeof row.demand_product_candidate_id === "string"
      ? row.demand_product_candidate_id
      : "";
    const candidate = candidateById.get(candidateId);
    const title = String(row.title ?? "").replace(/\s+/g, " ").trim();

    // Fail closed when the demand candidate or source title is missing. In
    // particular, do not leave a stale canonical product link on an unverified row.
    if (!candidate || !title) {
      const reason = !candidate
        ? "Demand candidate missing; identity cannot be verified"
        : "Source title missing; identity cannot be verified";
      pending.push({
        id: String(row.id),
        status: "identity_unconfirmed",
        payload: {
          identity_confidence: 0,
          identity_status: "identity_unconfirmed",
          identity_rationale: reason,
          identity_metadata: {
            missingDemandCandidate: !candidate,
            missingSourceTitle: !title,
          },
          product_id: null,
          updated_at: new Date().toISOString(),
        },
      });
      continue;
    }

    const relevance = assessDemandRelevance({
      demandQuery: candidate.query,
      demandCategory: candidate.category,
      title,
      category: row.product_type,
      sku: row.sku,
      imageUrl: row.image_url,
      cjQuery: row.cj_query,
    });

    const payload: Record<string, unknown> = {
      identity_confidence: relevance.score,
      identity_status: relevance.status,
      identity_rationale: relevance.rationale,
      identity_metadata: relevance.signals,
      updated_at: new Date().toISOString(),
    };

    if (relevance.status === "rejected_noise" || relevance.status === "identity_unconfirmed") {
      payload.product_id = null;
    }

    pending.push({
      id: String(row.id),
      payload,
      status: relevance.status,
    });
  }

  for (let start = 0; start < pending.length; start += IDENTITY_UPDATE_CONCURRENCY) {
    const batch = pending.slice(start, start + IDENTITY_UPDATE_CONCURRENCY);
    const results = await Promise.all(batch.map((item) =>
      supabase.from("demand_cj_products").update(item.payload).eq("id", item.id),
    ));
    const failed = results.find((result) => result.error);
    if (failed?.error) throw new Error(failed.error.message);
  }

  return {
    processed: pending.length,
    rejectedNoise: pending.filter((item) => item.status === "rejected_noise").length,
    unconfirmed: pending.filter((item) => item.status === "identity_unconfirmed").length,
    eligible: pending.filter((item) => item.status !== "rejected_noise" && item.status !== "identity_unconfirmed").length,
  };
}
