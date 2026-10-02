import "server-only";

import { classifyDemandIntent } from "@/lib/intelligence/classify-demand-intent";
import { isGeminiConfigured } from "@/lib/ai/gemini";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type DemandProductMatchResult = {
  processed: number;
  intentProduct: number;
  intentNonProduct: number;
  matched: number;
  unmatched: number;
  candidatesCreated: number;
  candidatesExisting: number;
  skippedInvalid: number;
};

type ProductIntent = {
  isProduct: boolean;
  category: string | null;
  reason: string;
};

const PRODUCT_CATEGORY_KEYWORDS: Record<string, string[]> = {
  "wireless earbuds": ["airpods", "air pods", "earbuds", "wireless earbuds", "true wireless", "bluetooth earbuds"],
  headphones: ["headphones", "wireless headphones", "noise cancelling", "noise-canceling"],
  smartphone: ["iphone", "ipad", "galaxy", "pixel", "android phone", "smartphone", "mobile phone"],
  skincare: ["serum", "moisturizer", "face cream", "skincare", "skin care", "sunscreen"],
  sneakers: ["sneakers", "running shoes", "trainers", "shoes"],
  automobile: ["car", "automobile", "vehicle", "toyota", "prius", "honda", "nissan", "mazda"],
};

const NON_PRODUCT_PATTERNS = [
  /weather/i, /forecast/i, /news/i, /election/i, /stock market/i,
  /exchange rate/i, /horoscope/i, /recipe/i, /restaurant/i, /movie/i,
  /anime episode/i, /sports score/i,
];

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function isBrokenText(value: string): boolean {
  return value.includes("\uFFFD") || /(?:繝ｻ繝ｻ繝ｻ|繝ｻ繝ｻ・ｽ)/.test(value);
}

function detectProductIntent(query: string): ProductIntent {
  const normalized = normalize(query);
  if (!normalized) return { isProduct: false, category: null, reason: "empty_query" };
  if (NON_PRODUCT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { isProduct: false, category: null, reason: "non_product_pattern" };
  }

  for (const [category, keywords] of Object.entries(PRODUCT_CATEGORY_KEYWORDS)) {
    const matchedKeyword = keywords.find((keyword) => normalized.includes(normalize(keyword)));
    if (matchedKeyword) {
      return { isProduct: true, category, reason: `product_keyword:${matchedKeyword}` };
    }
  }
  return { isProduct: false, category: null, reason: "no_product_signal" };
}

function productMatchesQuery(query: string, productName: string, allProductNames: string[]): boolean {
  const normalizedQuery = normalize(query);
  const normalizedProduct = normalize(productName);
  if (!normalizedQuery || !normalizedProduct) return false;

  if (
    normalizedQuery === normalizedProduct ||
    normalizedQuery.includes(normalizedProduct) ||
    normalizedProduct.includes(normalizedQuery)
  ) return true;

  const queryTokens = normalizedQuery
    .split(/[^\p{L}\p{N}]+/gu)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  if (queryTokens.length === 0) return false;

  const matchedTokens = queryTokens.filter((token) => normalizedProduct.includes(token));
  if (queryTokens.length >= 2) return matchedTokens.length === queryTokens.length;

  const token = queryTokens[0];
  const categoryKeywords = Object.values(PRODUCT_CATEGORY_KEYWORDS).flat();
  const isKnownProductTerm = categoryKeywords.some(
    (keyword) => normalize(keyword) === token || normalize(keyword).includes(token),
  );
  if (isKnownProductTerm) return matchedTokens.length === 1;

  const isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token);
  if (!isCjk || token.length < 3) return false;
  const candidateCount = allProductNames.reduce(
    (count, name) => count + (normalize(name).includes(token) ? 1 : 0),
    0,
  );
  return matchedTokens.length === 1 && candidateCount >= 1 && candidateCount <= 3;
}

export async function matchDemandProductsByCategory(): Promise<DemandProductMatchResult> {
  const supabase = createSupabaseAdminClient();

  const [{ data: demandRows, error: demandError }, { data: products, error: productError }, { data: candidates, error: candidateError }, { data: cjProducts, error: cjError }] = await Promise.all([
    supabase
      .from("demand_observations")
      .select("id, metadata, value, observed_at")
      .is("product_id", null)
      .in("signal_type", ["search_volume", "search_result_count"])
      .order("observed_at", { ascending: false }),
    supabase.from("product_intelligence").select("product_id, normalized_title"),
    supabase.from("demand_product_candidates").select("id, demand_observation_id"),
    supabase.from("demand_cj_products").select("demand_product_candidate_id, product_id, identity_status, identity_confidence"),
  ]);
  if (demandError) throw new Error(demandError.message);
  if (productError) throw new Error(productError.message);
  if (candidateError) throw new Error(candidateError.message);
  if (cjError) throw new Error(cjError.message);

  const productRows = products ?? [];
  const allProductNames = productRows.map((product) => product.normalized_title);

  // Preserve the evidence chain created by demand discovery:
  // demand observation -> candidate -> CJ product. This is a stronger match
  // than free-form title similarity because the supplier discovery step
  // already recorded the exact originating demand observation.
  const observationByCandidate = new Map(
    (candidates ?? []).map((candidate) => [candidate.id, candidate.demand_observation_id]),
  );
  const evidencePairs = new Map<string, { score: number; rationale: string }>();
  for (const cj of cjProducts ?? []) {
    if (!cj.product_id) continue;
    const demandObservationId = observationByCandidate.get(cj.demand_product_candidate_id);
    if (!demandObservationId) continue;
    if (cj.identity_status === "rejected_noise") continue;
    const confidence = typeof cj.identity_confidence === "number" ? cj.identity_confidence : Number(cj.identity_confidence ?? 0);
    if (Number.isFinite(confidence) && confidence > 0 && confidence < 0.65) continue;
    evidencePairs.set(`${demandObservationId}:${cj.product_id}`, {
      score: Number.isFinite(confidence) && confidence >= 0.88 ? 0.98 : 0.92,
      rationale: `Demand evidence chain matched: observation -> candidate ${cj.demand_product_candidate_id} -> CJ product`,
    });
  }

  if (evidencePairs.size > 0) {
    const rows = [...evidencePairs.entries()].map(([key, value]) => {
      const [demandObservationId, productId] = key.split(":");
      return {
        demand_observation_id: demandObservationId,
        product_id: productId,
        match_method: "supplier_demand_evidence",
        match_score: value.score,
        rationale: value.rationale,
      };
    });
    const { error } = await supabase
      .from("demand_product_matches")
      .upsert(rows, { onConflict: "demand_observation_id,product_id", ignoreDuplicates: true });
    if (error) throw new Error(`Failed to persist supplier-backed demand matches: ${error.message}`);
  }

  let processed = 0;
  let intentProduct = 0;
  let intentNonProduct = 0;
  let matched = 0;
  let unmatched = 0;
  let candidatesCreated = 0;
  let candidatesExisting = 0;
  let skippedInvalid = 0;

  for (const demand of demandRows ?? []) {
    processed += 1;
    const metadata = demand.metadata && typeof demand.metadata === "object" && !Array.isArray(demand.metadata)
      ? (demand.metadata as Record<string, unknown>)
      : {};
    if (metadata.invalid === true || metadata.invalid_reason === "unrecoverable_encoding") {
      skippedInvalid += 1;
      continue;
    }

    const query = typeof metadata.query === "string" ? metadata.query.trim() : "";
    if (!query || isBrokenText(query)) {
      skippedInvalid += 1;
      continue;
    }

    let intent = detectProductIntent(query);
    if (!intent.isProduct && intent.reason === "no_product_signal" && isGeminiConfigured()) {
      try {
        const aiIntent = await classifyDemandIntent(query);
        if (aiIntent.is_product_demand) {
          intent = { isProduct: true, category: aiIntent.category ?? null, reason: `gemini:${aiIntent.reason}` };
        }
      } catch (error) {
        console.error("[demand-gemini-classify]", { query, error });
      }
    }

    if (!intent.isProduct) {
      intentNonProduct += 1;
      continue;
    }
    intentProduct += 1;

    let rowMatched = false;
    for (const product of productRows) {
      if (!productMatchesQuery(query, product.normalized_title, allProductNames)) continue;
      const { error: insertError } = await supabase
        .from("demand_product_matches")
        .upsert(
          {
            demand_observation_id: demand.id,
            product_id: product.product_id,
            match_method: "keyword",
            match_score: 0.9,
            rationale: `Product intent query "${query}" matched "${product.normalized_title}" (${intent.reason})`,
          },
          { onConflict: "demand_observation_id,product_id", ignoreDuplicates: true },
        );
      if (insertError) throw new Error(`Failed to insert demand product match: ${insertError.message}`);
      rowMatched = true;
    }

    if (rowMatched) {
      matched += 1;
      continue;
    }

    unmatched += 1;
    const { data: existingCandidate, error: candidateLookupError } = await supabase
      .from("demand_product_candidates")
      .select("id, demand_observation_id, query")
      .eq("query", query)
      .maybeSingle();
    if (candidateLookupError) throw new Error(`Failed to lookup demand product candidate: ${candidateLookupError.message}`);
    if (existingCandidate) {
      candidatesExisting += 1;
      continue;
    }

    const source = typeof metadata.provider === "string" ? metadata.provider : "google_trends";
    const { error: candidateInsertError } = await supabase
      .from("demand_product_candidates")
      .insert({
        demand_observation_id: demand.id,
        query,
        category: intent.category,
        status: "new",
        source,
        rationale: `Product demand detected but no existing product matched: ${intent.reason}`,
      });
    if (candidateInsertError) {
      if (candidateInsertError.code === "23505") {
        candidatesExisting += 1;
        continue;
      }
      throw new Error(`Failed to insert demand product candidate: ${candidateInsertError.message}`);
    }
    candidatesCreated += 1;
  }

  return { processed, intentProduct, intentNonProduct, matched, unmatched, candidatesCreated, candidatesExisting, skippedInvalid };
}
