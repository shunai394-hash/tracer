import "server-only";

import { classifyDemandIntent } from "@/lib/intelligence/classify-demand-intent";
import { isGeminiConfigured } from "@/lib/ai/gemini";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  buildIdentifierIndex,
  exactIdentityVariantCompatible,
  isStrongDemandMatch,
  persistDemandMatches,
  readObservationIdentifiers,
  resolveExactIdentity,
  variantsCompatible,
  type DemandMatchRow as MatchRow,
} from "@/lib/intelligence/demand-match-evidence";

type DemandProductMatchResult = {
  processed: number;
  intentProduct: number;
  intentNonProduct: number;
  matched: number;
  unmatched: number;
  candidatesCreated: number;
  candidatesExisting: number;
  skippedInvalid: number;
  exactMatches: number;
  ambiguousIdentifier: number;
  variantRejected: number;
  brandRejected: number;
  geminiCalls: number;
  intentDeferred: number;
  matchRows: number;
  byMethod: Record<string, number>;
  persisted: number;
  persistSchema: "evidence" | "legacy" | "none";
  persistErrors: string[];
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

export function detectProductIntent(query: string): ProductIntent {
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

type PagedResult<T> = { data: T[] | null; error: { message: string } | null };

async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
  maxRows = 20_000,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows, error: null };
}

// Gemini intent classification is a network call per observation. Without a
// cap a run over ~260 unclassified Google Trends rows cannot finish inside the
// pipeline budget, so the step was deferred forever and nothing was matched.
const MAX_GEMINI_CLASSIFICATIONS_PER_RUN = 10;

export async function matchDemandProductsByCategory(): Promise<DemandProductMatchResult> {
  const supabase = createSupabaseAdminClient();

  // Paged reads: PostgREST caps a plain select at 1000 rows, which silently
  // dropped products (product_intelligence alone exceeds 1000 rows).
  const [demandResult, productResult, candidateResult, cjProductResult, sourceOfferResult, bestsellerResult, identifierResult] = await Promise.all([
    readAll((from, to) => supabase.from("demand_observations").select("id, metadata, value, observed_at").is("product_id", null).in("signal_type", ["search_volume", "search_result_count"]).order("observed_at", { ascending: false }).order("id").range(from, to)),
    readAll((from, to) => supabase.from("product_intelligence").select("product_id, normalized_title").order("product_id").range(from, to)),
    readAll((from, to) => supabase.from("demand_product_candidates").select("id, demand_observation_id").order("id").range(from, to)),
    readAll((from, to) => supabase.from("demand_cj_products").select("id, demand_product_candidate_id, product_id, identity_status, identity_confidence").order("id").range(from, to)),
    readAll((from, to) => supabase.from("product_offers").select("id, product_id, metadata, seller_name, observed_at").eq("seller_name", "CJdropshipping").order("id").range(from, to)),
    readAll((from, to) => supabase.from("marketplace_bestsellers").select("product_id, jan, gtin, ean, upc, mpn, model, brand").not("product_id", "is", null).order("id").range(from, to)),
    readAll((from, to) => supabase.from("product_identifiers").select("product_id, scheme, value").not("product_id", "is", null).order("id").range(from, to)),
  ]);
  if (demandResult.error) throw new Error(demandResult.error.message);
  if (productResult.error) throw new Error(productResult.error.message);
  if (candidateResult.error) throw new Error(candidateResult.error.message);
  if (cjProductResult.error) throw new Error(cjProductResult.error.message);
  if (sourceOfferResult.error) throw new Error(sourceOfferResult.error.message);
  if (bestsellerResult.error) throw new Error(bestsellerResult.error.message);
  if (identifierResult.error) throw new Error(identifierResult.error.message);

  const demandRows = demandResult.data ?? [];
  const productRows = productResult.data ?? [];
  const allProductNames = productRows.map((product) => product.normalized_title);
  const productTitleById = new Map(productRows.map((product) => [String(product.product_id), product.normalized_title]));

  // Identifier index of market products. A key that maps to more than one
  // product is ambiguous and never produces an exact match.
  const identifierIndex = buildIdentifierIndex(bestsellerResult.data ?? [], identifierResult.data ?? []);

  const matchRows = new Map<string, MatchRow>();
  const keep = (row: MatchRow) => {
    const key = `${row.demandObservationId}:${row.productId}`;
    const existing = matchRows.get(key);
    // Never let weaker evidence overwrite stronger evidence for the same pair.
    if (existing && isStrongDemandMatch({ match_method: existing.evidence.method }) && !isStrongDemandMatch({ match_method: row.evidence.method })) return;
    matchRows.set(key, row);
  };

  // Search provenance: CJ returned this product for the demand query. That is
  // a topical association, not proof of identity -> weak.
  for (const offer of sourceOfferResult.data ?? []) {
    const metadata = offer.metadata && typeof offer.metadata === "object" && !Array.isArray(offer.metadata)
      ? (offer.metadata as Record<string, unknown>)
      : {};
    const observationId = typeof metadata.demand_observation_id === "string" ? metadata.demand_observation_id : null;
    if (!observationId || !offer.product_id) continue;
    keep({
      demandObservationId: observationId,
      productId: offer.product_id,
      score: 0.5,
      evidence: {
        method: "search_provenance",
        rationale: "CJ offer was discovered by searching this demand query (supplier search provenance, not product identity)",
        facts: { offer_id: offer.id, demand_query: metadata.demand_query ?? null },
        sourceId: offer.id,
      },
    });
  }

  // demand_cj_products "linked" is assigned from query/title token relevance
  // (assessDemandRelevance), i.e. text similarity -> weak.
  const observationByCandidate = new Map((candidateResult.data ?? []).map((candidate) => [candidate.id, candidate.demand_observation_id]));
  for (const cj of cjProductResult.data ?? []) {
    if (!cj.product_id || cj.identity_status !== "linked") continue;
    const observationId = observationByCandidate.get(cj.demand_product_candidate_id);
    if (!observationId) continue;
    const confidence = Number(cj.identity_confidence ?? 0);
    if (!Number.isFinite(confidence) || confidence < 0.88) continue;
    keep({
      demandObservationId: observationId,
      productId: cj.product_id,
      score: Math.min(confidence, 0.6),
      evidence: {
        method: "weak_text_similarity",
        rationale: `Demand query relevance to CJ title (candidate ${cj.demand_product_candidate_id}); text relevance only`,
        facts: { demand_cj_product_id: cj.id, relevance: confidence },
        sourceId: cj.id,
      },
    });
  }

  let processed = 0, intentProduct = 0, intentNonProduct = 0, matched = 0, unmatched = 0;
  let candidatesCreated = 0, candidatesExisting = 0, skippedInvalid = 0;
  let exactMatches = 0, ambiguousIdentifier = 0, variantRejected = 0, brandRejected = 0;
  let geminiCalls = 0, intentDeferred = 0;
  const candidateObservationIds = new Set((candidateResult.data ?? []).map((row) => String(row.demand_observation_id)));

  for (const demand of demandRows) {
    processed += 1;
    const metadata = demand.metadata && typeof demand.metadata === "object" && !Array.isArray(demand.metadata)
      ? (demand.metadata as Record<string, unknown>)
      : {};
    if (metadata.invalid === true || metadata.invalid_reason === "unrecoverable_encoding") { skippedInvalid += 1; continue; }

    const query = typeof metadata.query === "string" ? metadata.query.trim() : "";
    if (!query || isBrokenText(query)) { skippedInvalid += 1; continue; }

    // 1-3. Identifier-grade evidence in the observation itself.
    const decision = resolveExactIdentity(readObservationIdentifiers(metadata), identifierIndex);
    if (decision.status === "ambiguous") ambiguousIdentifier += 1;
    if (decision.status === "brand_conflict") brandRejected += 1;
    if (decision.status === "exact") {
      const exactProductTitle = productTitleById.get(decision.productId) ?? "";
      const exactVariantCompatible = exactIdentityVariantCompatible(query, exactProductTitle);
      if (exactVariantCompatible) {
        exactMatches += 1;
        keep({
          demandObservationId: demand.id,
          productId: decision.productId,
          score: 1,
          evidence: {
            method: decision.method,
            rationale: `Observation identifier exactly and uniquely matches the product (${decision.method})`,
            facts: { ...decision.facts, variant_checked: true },
            sourceId: demand.id,
          },
        });
        matched += 1;
        continue;
      }
      // An identifier can be exact while the demand query names a different
      // generation/tier/size/capacity/pack. Do not promote that contradiction
      // to strong demand evidence; leave the observation on the candidate path.
      variantRejected += 1;
    }

    let intent = detectProductIntent(query);
    // Observations that already produced a candidate were classified before;
    // do not pay for another Gemini call on every run.
    if (!intent.isProduct && intent.reason === "no_product_signal" && candidateObservationIds.has(demand.id)) {
      intentNonProduct += 1;
      continue;
    }
    if (!intent.isProduct && intent.reason === "no_product_signal" && isGeminiConfigured()) {
      if (geminiCalls >= MAX_GEMINI_CLASSIFICATIONS_PER_RUN) { intentDeferred += 1; continue; }
      geminiCalls += 1;
      try {
        const aiIntent = await classifyDemandIntent(query);
        if (aiIntent.is_product_demand) intent = { isProduct: true, category: aiIntent.category ?? null, reason: `gemini:${aiIntent.reason}` };
      } catch (error) {
        console.error("[demand-gemini-classify]", { query, error });
      }
    }
    if (!intent.isProduct) { intentNonProduct += 1; continue; }
    intentProduct += 1;

    // 5-6. Title evidence: recorded as weak only, and never across a variant
    // conflict ("iPhone 15 case" must not match "iPhone 15 Pro case").
    let rowMatched = false;
    for (const product of productRows) {
      if (!productMatchesQuery(query, product.normalized_title, allProductNames)) continue;
      const variant = variantsCompatible(query, product.normalized_title);
      if (!variant.compatible) { variantRejected += 1; continue; }
      const exactTitle = normalize(query) === normalize(product.normalized_title);
      keep({
        demandObservationId: demand.id,
        productId: product.product_id,
        score: exactTitle ? 0.6 : 0.4,
        evidence: {
          method: exactTitle ? "normalized_title" : "weak_text_similarity",
          rationale: `Query "${query}" ${exactTitle ? "equals" : "token-matches"} "${product.normalized_title}" (${intent.reason}); text evidence only`,
          facts: { query, title: product.normalized_title, intent: intent.reason },
          sourceId: demand.id,
        },
      });
      rowMatched = true;
    }

    // Weak title/text evidence is traceability only. It must not terminate
    // the flow: the same observation still needs a candidate so supplier
    // research can resolve an identifier/model/variant.
    if (rowMatched) matched += 1;
    else unmatched += 1;

    // Candidate identity is scoped to BOTH the observation and query. A
    // query-only lookup can collide across observations and make maybeSingle()
    // fail or incorrectly reuse another observation's candidate.
    const { data: existingCandidate, error: candidateLookupError } = await supabase
      .from("demand_product_candidates")
      .select("id")
      .eq("demand_observation_id", demand.id)
      .eq("query", query)
      .maybeSingle();
    if (candidateLookupError) throw new Error(`Failed to lookup demand product candidate: ${candidateLookupError.message}`);
    if (existingCandidate) { candidatesExisting += 1; continue; }

    const source = typeof metadata.provider === "string" ? metadata.provider : "google_trends";
    const rationale = rowMatched
      ? `Weak demand match recorded for query ${JSON.stringify(query)}; candidate requires supplier/identity verification (${intent.reason})`
      : `Product demand detected but no existing product matched: ${intent.reason}`;
    const { error: candidateInsertError } = await supabase.from("demand_product_candidates").insert({
      demand_observation_id: demand.id,
      query,
      category: intent.category,
      status: "new",
      source,
      rationale,
    });
    if (candidateInsertError) {
      if (candidateInsertError.code === "23505") { candidatesExisting += 1; continue; }
      throw new Error(`Failed to insert demand product candidate: ${candidateInsertError.message}`);
    }
    candidatesCreated += 1;
  }

  const rows = [...matchRows.values()];
  const persisted = await persistDemandMatches(supabase, rows);
  const byMethod: Record<string, number> = {};
  for (const row of rows) byMethod[row.evidence.method] = (byMethod[row.evidence.method] ?? 0) + 1;

  return {
    processed, intentProduct, intentNonProduct, matched, unmatched, candidatesCreated, candidatesExisting, skippedInvalid,
    exactMatches, ambiguousIdentifier, variantRejected, brandRejected, geminiCalls, intentDeferred,
    matchRows: rows.length,
    byMethod,
    persisted: persisted.written,
    persistSchema: persisted.schema,
    persistErrors: persisted.errors,
  };
}
