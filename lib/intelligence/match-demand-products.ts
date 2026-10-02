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

type ProductIntent = { isProduct: boolean; category: string | null; reason: string };

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
    if (matchedKeyword) return { isProduct: true, category, reason: `product_keyword:${matchedKeyword}` };
  }
  return { isProduct: false, category: null, reason: "no_product_signal" };
}

function productMatchesQuery(query: string, productName: string, allProductNames: string[]): boolean {
  const normalizedQuery = normalize(query);
  const normalizedProduct = normalize(productName);
  if (!normalizedQuery || !normalizedProduct) return false;
  if (normalizedQuery === normalizedProduct) return true;

  const queryTokens = normalizedQuery.split(/[^\p{L}\p{N}]+/gu).map((token) => token.trim()).filter((token) => token.length >= 2);
  if (queryTokens.length === 0) return false;
  const matchedTokens = queryTokens.filter((token) => normalizedProduct.includes(token));
  if (queryTokens.length >= 2) return matchedTokens.length === queryTokens.length;

  const token = queryTokens[0];
  const categoryKeywords = Object.values(PRODUCT_CATEGORY_KEYWORDS).flat();
  const isKnownProductTerm = categoryKeywords.some((keyword) => normalize(keyword) === token || normalize(keyword).includes(token));
  if (isKnownProductTerm) return matchedTokens.length === 1;

  const isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token);
  if (!isCjk || token.length < 3) return false;
  const candidateCount = allProductNames.reduce((count, name) => count + (normalize(name).includes(token) ? 1 : 0), 0);
  return matchedTokens.length === 1 && candidateCount >= 1 && candidateCount <= 3;
}

export async function matchDemandProductsByCategory(): Promise<DemandProductMatchResult> {
  const supabase = createSupabaseAdminClient();

  const [demandResult, productResult, candidateResult, cjProductResult, sourceOfferResult] = await Promise.all([
    supabase.from("demand_observations").select("id, metadata, value, observed_at").is("product_id", null).in("signal_type", ["search_volume", "search_result_count"]).order("observed_at", { ascending: false }),
    supabase.from("product_intelligence").select("product_id, normalized_title"),
    supabase.from("demand_product_candidates").select("id, demand_observation_id"),
    supabase.from("demand_cj_products").select("id, demand_product_candidate_id, product_id, identity_status, identity_confidence"),
    supabase.from("product_offers").select("id, product_id, metadata, seller_name, observed_at").eq("seller_name", "CJdropshipping"),
  ]);
  if (demandResult.error) throw new Error(demandResult.error.message);
  if (productResult.error) throw new Error(productResult.error.message);
  if (candidateResult.error) throw new Error(candidateResult.error.message);
  if (cjProductResult.error) throw new Error(cjProductResult.error.message);
  if (sourceOfferResult.error) throw new Error(sourceOfferResult.error.message);

  const demandRows = demandResult.data ?? [];
  const productRows = productResult.data ?? [];
  const allProductNames = productRows.map((product) => product.normalized_title);

  const evidenceRows = new Map<string, {
    score: number;
    rationale: string;
    evidenceType: string;
    sourceId: string;
    observedAt: string;
  }>();

  for (const offer of sourceOfferResult.data ?? []) {
    const metadata = offer.metadata && typeof offer.metadata === "object" && !Array.isArray(offer.metadata)
      ? (offer.metadata as Record<string, unknown>)
      : {};
    const observationId = typeof metadata.demand_observation_id === "string" ? metadata.demand_observation_id : null;
    if (!observationId || !offer.product_id) continue;
    evidenceRows.set(`${observationId}:${offer.product_id}`, {
      score: 0.98,
      rationale: "Exact supplier discovery provenance: CJ offer metadata references the originating demand observation",
      evidenceType: "supplier_demand_evidence",
      sourceId: offer.id,
      observedAt: offer.observed_at ?? new Date().toISOString(),
    });
  }

  const observationByCandidate = new Map((candidateResult.data ?? []).map((candidate) => [candidate.id, candidate.demand_observation_id]));
  for (const cj of cjProductResult.data ?? []) {
    if (!cj.product_id || cj.identity_status !== "linked") continue;
    const observationId = observationByCandidate.get(cj.demand_product_candidate_id);
    if (!observationId) continue;
    const confidence = Number(cj.identity_confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0.88) continue;
    evidenceRows.set(`${observationId}:${cj.product_id}`, {
      score: confidence,
      rationale: `Demand evidence chain: observation -> candidate ${cj.demand_product_candidate_id} -> verified linked CJ product`,
      evidenceType: "supplier_demand_evidence",
      sourceId: cj.id,
      observedAt: new Date().toISOString(),
    });
  }

  if (evidenceRows.size > 0) {
    const rows = [...evidenceRows.entries()].map(([key, value]) => {
      const separator = key.lastIndexOf(":");
      return {
        demand_observation_id: key.slice(0, separator),
        product_id: key.slice(separator + 1),
        match_method: value.evidenceType,
        match_score: value.score,
        rationale: value.rationale,
        evidence_type: value.evidenceType,
        source_id: value.sourceId,
        observed_at: value.observedAt,
      };
    });
    const { error } = await supabase.from("demand_product_matches").upsert(rows, { onConflict: "demand_observation_id,product_id", ignoreDuplicates: true });
    if (error) throw new Error(`Failed to persist supplier-backed demand matches: ${error.message}`);
  }

  let processed = 0, intentProduct = 0, intentNonProduct = 0, matched = 0, unmatched = 0;
  let candidatesCreated = 0, candidatesExisting = 0, skippedInvalid = 0;

  for (const demand of demandRows) {
    processed += 1;
    const metadata = demand.metadata && typeof demand.metadata === "object" && !Array.isArray(demand.metadata)
      ? (demand.metadata as Record<string, unknown>)
      : {};
    if (metadata.invalid === true || metadata.invalid_reason === "unrecoverable_encoding") { skippedInvalid += 1; continue; }

    const query = typeof metadata.query === "string" ? metadata.query.trim() : "";
    if (!query || isBrokenText(query)) { skippedInvalid += 1; continue; }

    let intent = detectProductIntent(query);
    if (!intent.isProduct && intent.reason === "no_product_signal" && isGeminiConfigured()) {
      try {
        const aiIntent = await classifyDemandIntent(query);
        if (aiIntent.is_product_demand) intent = { isProduct: true, category: aiIntent.category ?? null, reason: `gemini:${aiIntent.reason}` };
      } catch (error) {
        console.error("[demand-gemini-classify]", { query, error });
      }
    }
    if (!intent.isProduct) { intentNonProduct += 1; continue; }
    intentProduct += 1;

    let rowMatched = false;
    for (const product of productRows) {
      if (!productMatchesQuery(query, product.normalized_title, allProductNames)) continue;
      const { error } = await supabase.from("demand_product_matches").upsert({
        demand_observation_id: demand.id,
        product_id: product.product_id,
        match_method: "keyword",
        match_score: 0.9,
        rationale: `Product intent query "${query}" matched "${product.normalized_title}" (${intent.reason})`,
        evidence_type: "query_title_match",
        source_id: demand.id,
        observed_at: demand.observed_at,
      }, { onConflict: "demand_observation_id,product_id", ignoreDuplicates: true });
      if (error) throw new Error(`Failed to insert demand product match: ${error.message}`);
      rowMatched = true;
    }

    if (rowMatched) { matched += 1; continue; }
    unmatched += 1;

    const { data: existingCandidate, error: candidateLookupError } = await supabase.from("demand_product_candidates").select("id, demand_observation_id, query").eq("query", query).maybeSingle();
    if (candidateLookupError) throw new Error(`Failed to lookup demand product candidate: ${candidateLookupError.message}`);
    if (existingCandidate) { candidatesExisting += 1; continue; }

    const source = typeof metadata.provider === "string" ? metadata.provider : "google_trends";
    const { error: candidateInsertError } = await supabase.from("demand_product_candidates").insert({
      demand_observation_id: demand.id,
      query,
      category: intent.category,
      status: "new",
      source,
      rationale: `Product demand detected but no existing product matched: ${intent.reason}`,
    });
    if (candidateInsertError) {
      if (candidateInsertError.code === "23505") { candidatesExisting += 1; continue; }
      throw new Error(`Failed to insert demand product candidate: ${candidateInsertError.message}`);
    }
    candidatesCreated += 1;
  }

  return { processed, intentProduct, intentNonProduct, matched, unmatched, candidatesCreated, candidatesExisting, skippedInvalid };
}
