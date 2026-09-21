import {
  normalizeIdentityText,
  tokenizeIdentityText,
} from "@/lib/intelligence/identity-confidence";
import { scoreFromKnown } from "@/lib/intelligence/sellability";

export type SearchFitDimension = {
  key: string;
  score: number | null;
  confidence: number;
  evidence: Record<string, unknown>;
};

export type SearchDiscoveryFitInput = {
  demandQuery: string | null;
  demandValue: number | null;
  searchGrowth: number | null;
  productTitle: string | null;
  category: string | null;
  competitorCount: number | null;
  reviewValue: number | null;
  socialValue: number | null;
  intentIsProduct: boolean | null;
};

export type SearchDiscoveryFitResult = {
  score: number | null;
  confidence: number;
  dimensions: SearchFitDimension[];
  reasons: string[];
};

function overlapRatio(query: string | null, title: string | null): number | null {
  const queryTokens = tokenizeIdentityText(query);
  const titleTokens = new Set(tokenizeIdentityText(title));
  if (queryTokens.length === 0 || titleTokens.size === 0) return null;
  const hits = queryTokens.filter((token) => titleTokens.has(token)).length;
  return hits / queryTokens.length;
}

function intentClarityScore(query: string | null, intentIsProduct: boolean | null): {
  score: number | null;
  confidence: number;
} {
  if (!query) return { score: null, confidence: 0 };
  if (intentIsProduct === false) return { score: 15, confidence: 0.7 };
  const tokens = tokenizeIdentityText(query);
  if (tokens.length === 0) return { score: null, confidence: 0 };
  const specific = tokens.length >= 2 || normalizeIdentityText(query).length >= 6;
  if (intentIsProduct === true && specific) return { score: 85, confidence: 0.75 };
  if (specific) return { score: 70, confidence: 0.55 };
  return { score: 45, confidence: 0.4 };
}

export function evaluateSearchDiscoveryFit(
  input: SearchDiscoveryFitInput,
): SearchDiscoveryFitResult {
  const keywordOverlap = overlapRatio(input.demandQuery, input.productTitle);
  const intent = intentClarityScore(input.demandQuery, input.intentIsProduct);
  const categoryOverlap = overlapRatio(input.demandQuery, input.category);
  const titleKnown = Boolean(input.productTitle);
  const queryKnown = Boolean(input.demandQuery);

  const dimensions: SearchFitDimension[] = [
    {
      key: "search_demand",
      score:
        input.demandValue === null
          ? null
          : Math.max(0, Math.min(100, (input.demandValue / 1000) * 100)),
      confidence: input.demandValue === null ? 0 : 0.75,
      evidence: { demand_value: input.demandValue },
    },
    {
      key: "demand_growth",
      score:
        input.searchGrowth === null
          ? null
          : Math.max(0, Math.min(100, 50 + input.searchGrowth / 200)),
      confidence: input.searchGrowth === null ? 0 : 0.7,
      evidence: { search_growth: input.searchGrowth },
    },
    {
      key: "search_intent_clarity",
      score: intent.score,
      confidence: intent.confidence,
      evidence: {
        demand_query: input.demandQuery,
        intent_is_product: input.intentIsProduct,
      },
    },
    {
      key: "keyword_clarity",
      score:
        keywordOverlap === null ? null : Math.max(0, Math.min(100, keywordOverlap * 100)),
      confidence: keywordOverlap === null ? 0 : 0.7,
      evidence: { title_query_overlap: keywordOverlap },
    },
    {
      key: "use_case_relevance",
      score:
        categoryOverlap === null
          ? input.category
            ? 40
            : null
          : Math.max(0, Math.min(100, 40 + categoryOverlap * 60)),
      confidence: input.category ? 0.5 : 0,
      evidence: { category: input.category, category_overlap: categoryOverlap },
    },
    {
      key: "comparison_content_fit",
      score:
        input.competitorCount === null
          ? null
          : input.competitorCount >= 2 && keywordOverlap !== null && keywordOverlap >= 0.4
            ? 75
            : input.competitorCount >= 2
              ? 55
              : 35,
      confidence: input.competitorCount === null ? 0 : 0.5,
      evidence: {
        competitor_count: input.competitorCount,
        note: "marketplace_offers_not_serp_content",
      },
    },
    {
      key: "review_ugc_fit",
      score:
        input.reviewValue === null
          ? null
          : Math.max(0, Math.min(100, Number(input.reviewValue))),
      confidence: input.reviewValue === null ? 0 : 0.55,
      evidence: { review_value: input.reviewValue },
    },
    {
      key: "video_content_fit",
      score: null,
      confidence: 0,
      evidence: { note: "no_video_observation" },
    },
    {
      key: "ai_search_explainability",
      score:
        titleKnown && queryKnown
          ? input.category
            ? 80
            : 65
          : titleKnown || queryKnown
            ? 40
            : null,
      confidence: titleKnown && queryKnown ? 0.6 : titleKnown || queryKnown ? 0.35 : 0,
      evidence: {
        has_title: titleKnown,
        has_demand_query: queryKnown,
        has_category: Boolean(input.category),
      },
    },
    {
      key: "competitor_content",
      score: null,
      confidence: 0,
      evidence: { note: "serp_content_not_observed" },
    },
  ];

  if (input.socialValue !== null) {
    dimensions.push({
      key: "social_discovery",
      score: Math.max(0, Math.min(100, Number(input.socialValue) / 1000)),
      confidence: 0.55,
      evidence: { social_value: input.socialValue },
    });
  }

  const scored = scoreFromKnown(
    dimensions.map((dimension) => ({
      score: dimension.score,
      weight: dimension.key === "video_content_fit" || dimension.key === "competitor_content"
        ? 0
        : 1,
      confidence: dimension.confidence,
    })),
  );

  const reasons: string[] = [];
  const demand = dimensions.find((item) => item.key === "search_demand");
  if (demand && demand.score !== null && demand.score >= 50) {
    reasons.push("検索需要が観測されている");
  }
  if (input.searchGrowth !== null && input.searchGrowth > 0) {
    reasons.push("検索需要が上昇している");
  }
  if (intent.score !== null && intent.score >= 70) {
    reasons.push("検索意図が明確");
  }
  if (keywordOverlap !== null && keywordOverlap >= 0.4) {
    reasons.push("商品名と需要キーワードの対応が確認できる");
  }
  if (titleKnown && queryKnown) {
    reasons.push("AI検索で説明しやすい商品文脈が揃っている");
  }

  return {
    score: scored.score,
    confidence: scored.confidence,
    dimensions,
    reasons,
  };
}

export function verifySearchFitInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const unknown = evaluateSearchDiscoveryFit({
    demandQuery: null,
    demandValue: null,
    searchGrowth: null,
    productTitle: "Toyota Prius Floor Mat",
    category: null,
    competitorCount: null,
    reviewValue: null,
    socialValue: null,
    intentIsProduct: null,
  });

  const known = evaluateSearchDiscoveryFit({
    demandQuery: "toyota prius floor mat",
    demandValue: 2500,
    searchGrowth: 400,
    productTitle: "Toyota Prius Floor Mat",
    category: "automobile",
    competitorCount: 2,
    reviewValue: null,
    socialValue: null,
    intentIsProduct: true,
  });

  const video = known.dimensions.find((item) => item.key === "video_content_fit");
  const content = known.dimensions.find((item) => item.key === "competitor_content");

  const cases = [
    {
      name: "missing_demand_does_not_fabricate_search_score",
      expected: true,
      actual:
        unknown.dimensions.find((item) => item.key === "search_demand")?.score ===
        null,
    },
    {
      name: "known_query_and_title_produces_fit",
      expected: true,
      actual: known.score !== null && known.score > 40,
    },
    {
      name: "unobserved_video_and_serp_stay_unknown",
      expected: true,
      actual: video?.score === null && content?.score === null,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
