export type IdentityStatus = "unlinked" | "linked" | "rejected_noise";

export type IdentityAssessment = {
  score: number;
  status: IdentityStatus;
  rationale: string;
  signals: Record<string, unknown>;
};

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "to",
  "of",
  "in",
  "on",
  "by",
  "from",
]);

const TOKEN_ALIASES: Record<string, string[]> = {
  "トヨタ": ["toyota"],
  toyota: ["トヨタ"],
  "プリウス": ["prius"],
  prius: ["プリウス"],
  "イヤホン": ["earbuds", "earphone", "airpods"],
  earbuds: ["イヤホン", "earphone"],
  earphone: ["earbuds", "イヤホン"],
  airpods: ["earbuds", "イヤホン"],
  headphones: ["headset"],
  "シャツ": ["shirt"],
  shirt: ["シャツ"],
};

const UNRELATED_ACCESSORY_TERMS = [
  "hair",
  "wig",
  "scrunchie",
  "headband",
  "barrette",
  "bicycle",
  "bike",
  "watch strap",
  "watch band",
  "watch accessory",
  "bag charm",
  "handbag",
  "purse",
  "key cover",
  "keychain",
  "key ring",
  "phone case",
];

const AUTOMOBILE_DEMAND_TERMS = [
  "prius",
  "toyota",
  "honda",
  "nissan",
  "mazda",
  "automobile",
  "vehicle",
  "car",
  "プリウス",
  "トヨタ",
];

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function normalizeIdentityText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeIdentityText(value: string | null | undefined): string[] {
  const normalized = normalizeIdentityText(value);
  if (!normalized) return [];

  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));

  const expanded = tokens.flatMap((token) => [token, ...(TOKEN_ALIASES[token] ?? [])]);

  return unique(expanded.map((token) => normalizeIdentityText(token)).filter(Boolean));
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);

  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function overlapCount(a: string[], b: string[]): number {
  const right = new Set(b);
  return a.filter((token) => right.has(token)).length;
}

function includesUnrelatedAccessory(title: string): boolean {
  const normalized = normalizeIdentityText(title);
  return UNRELATED_ACCESSORY_TERMS.some((term) =>
    normalized.includes(normalizeIdentityText(term)),
  );
}

function looksLikeAutomobileDemand(
  query: string,
  category: string | null | undefined,
): boolean {
  const haystack = `${normalizeIdentityText(query)} ${normalizeIdentityText(category)}`;
  return AUTOMOBILE_DEMAND_TERMS.some((term) =>
    haystack.includes(normalizeIdentityText(term)),
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export const DEMAND_RELEVANCE_THRESHOLD = 0.65;
export const CANONICAL_LINK_THRESHOLD = 0.82;

/**
 * Does this CJ/source product belong to the demand candidate at all?
 * Unrelated accessories for a car query are rejected here and never
 * enter Product Intelligence.
 */
export function assessDemandRelevance(args: {
  demandQuery: string;
  demandCategory?: string | null;
  title: string;
  brand?: string | null;
  category?: string | null;
  sku?: string | null;
  imageUrl?: string | null;
  cjQuery?: string | null;
}): IdentityAssessment {
  const queryTokens = tokenizeIdentityText(args.demandQuery);
  const titleTokens = tokenizeIdentityText(args.title);
  const brandTokens = tokenizeIdentityText(args.brand);
  const categoryTokens = tokenizeIdentityText(
    [args.demandCategory, args.category].filter(Boolean).join(" "),
  );
  const cjQueryTokens = tokenizeIdentityText(args.cjQuery);

  const titleOverlap = overlapCount(queryTokens, titleTokens);
  const titleJaccard = jaccard(queryTokens, titleTokens);
  const queryToCj = jaccard(queryTokens, cjQueryTokens);
  const brandOverlap = overlapCount(queryTokens, brandTokens);
  const categoryOverlap = overlapCount(queryTokens, categoryTokens);

  const automobileDemand = looksLikeAutomobileDemand(
    args.demandQuery,
    args.demandCategory,
  );
  const accessoryNoise = includesUnrelatedAccessory(args.title);

  let score = 0;
  const signals: Record<string, unknown> = {
    titleOverlap,
    titleJaccard: Number(titleJaccard.toFixed(4)),
    queryToCj: Number(queryToCj.toFixed(4)),
    brandOverlap,
    categoryOverlap,
    automobileDemand,
    accessoryNoise,
    hasSku: Boolean(args.sku),
    hasImage: Boolean(args.imageUrl),
  };

  if (automobileDemand && accessoryNoise && titleOverlap < 2) {
    return {
      score: 0.05,
      status: "rejected_noise",
      rationale:
        "Demand is vehicle-related but the source product looks like an unrelated accessory",
      signals,
    };
  }

  score += Math.min(0.55, titleJaccard * 0.9 + titleOverlap * 0.12);
  if (titleOverlap >= 2) score += 0.2;
  if (brandOverlap > 0) score += 0.08;
  if (categoryOverlap > 0) score += 0.05;
  if (queryToCj >= 0.4) score += 0.07;
  if (args.sku) score += 0.03;
  if (args.imageUrl) score += 0.02;

  const clamped = Number(clamp01(score).toFixed(4));

  if (clamped < DEMAND_RELEVANCE_THRESHOLD) {
    return {
      score: clamped,
      status: "rejected_noise",
      rationale: "Source product does not share enough identity with the demand query",
      signals,
    };
  }

  return {
    score: clamped,
    status: "unlinked",
    rationale: "Source product is relevant to the demand query but not linked to a canonical product yet",
    signals,
  };
}

/**
 * Is this source product the same canonical product as an existing catalog row?
 * High bar: do not merge distinct items just because they share a demand query.
 */
export function assessCanonicalIdentity(args: {
  sourceTitle: string;
  sourceBrand?: string | null;
  sourceSku?: string | null;
  canonicalName: string;
  canonicalBrand?: string | null;
}): IdentityAssessment {
  const sourceTokens = tokenizeIdentityText(args.sourceTitle);
  const canonicalTokens = tokenizeIdentityText(args.canonicalName);
  const sourceBrand = tokenizeIdentityText(args.sourceBrand);
  const canonicalBrand = tokenizeIdentityText(args.canonicalBrand);

  const titleJaccard = jaccard(sourceTokens, canonicalTokens);
  const titleOverlap = overlapCount(sourceTokens, canonicalTokens);
  const brandMatch =
    sourceBrand.length > 0 &&
    canonicalBrand.length > 0 &&
    overlapCount(sourceBrand, canonicalBrand) > 0;

  const normalizedSource = normalizeIdentityText(args.sourceTitle);
  const normalizedCanonical = normalizeIdentityText(args.canonicalName);
  const exact =
    normalizedSource.length > 0 && normalizedSource === normalizedCanonical;

  let score = exact ? 0.96 : titleJaccard;
  if (titleOverlap >= 3) score += 0.08;
  if (brandMatch) score += 0.06;
  if (args.sourceSku) score += 0.02;

  const clamped = Number(clamp01(score).toFixed(4));
  const linked = exact || clamped >= CANONICAL_LINK_THRESHOLD;

  return {
    score: clamped,
    status: linked ? "linked" : "unlinked",
    rationale: linked
      ? "Source title/brand is similar enough to treat as the same canonical product"
      : "Source product is not similar enough to an existing canonical product",
    signals: {
      titleJaccard: Number(titleJaccard.toFixed(4)),
      titleOverlap,
      brandMatch,
      exact,
    },
  };
}

export function verifyIdentityInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: IdentityStatus; actual: IdentityStatus; score: number }>;
} {
  const fixtures: Array<{
    name: string;
    expected: IdentityStatus;
    assessment: IdentityAssessment;
  }> = [
    {
      name: "prius_hair_accessory_rejected",
      expected: "rejected_noise",
      assessment: assessDemandRelevance({
        demandQuery: "トヨタ・プリウス",
        demandCategory: "automobile",
        title: "Fashion Hair Clips Women Accessories",
        category: "hair accessories",
      }),
    },
    {
      name: "prius_bicycle_accessory_rejected",
      expected: "rejected_noise",
      assessment: assessDemandRelevance({
        demandQuery: "toyota prius",
        demandCategory: "automobile",
        title: "Bicycle Handlebar Bag Accessories",
        category: "bicycle accessories",
      }),
    },
    {
      name: "prius_watch_accessory_rejected",
      expected: "rejected_noise",
      assessment: assessDemandRelevance({
        demandQuery: "toyota prius",
        demandCategory: "automobile",
        title: "Watch Band Strap Accessories",
        category: "watch accessories",
      }),
    },
    {
      name: "prius_key_cover_rejected",
      expected: "rejected_noise",
      assessment: assessDemandRelevance({
        demandQuery: "toyota prius",
        demandCategory: "automobile",
        title: "Simple Car Carbon Fiber Key Cover",
      }),
    },
    {
      name: "prius_floor_mat_accepted",
      expected: "unlinked",
      assessment: assessDemandRelevance({
        demandQuery: "toyota prius",
        demandCategory: "automobile",
        title: "Toyota Prius Floor Mat",
        sku: "PRI-MAT-01",
        imageUrl: "https://example.com/mat.jpg",
      }),
    },
    {
      name: "earbuds_match",
      expected: "unlinked",
      assessment: assessDemandRelevance({
        demandQuery: "wireless earbuds",
        demandCategory: "wireless earbuds",
        title: "ANC True Wireless Earbuds Bluetooth 5.4",
        imageUrl: "https://example.com/buds.jpg",
      }),
    },
    {
      name: "distinct_products_not_linked",
      expected: "unlinked",
      assessment: assessCanonicalIdentity({
        sourceTitle: "Toyota Prius Floor Mat",
        canonicalName: "Apple AirPods Pro 3",
      }),
    },
    {
      name: "same_product_linked",
      expected: "linked",
      assessment: assessCanonicalIdentity({
        sourceTitle: "Apple AirPods Pro 3",
        sourceBrand: "Apple",
        canonicalName: "Apple AirPods Pro 3",
        canonicalBrand: "Apple",
      }),
    },
  ];

  const cases = fixtures.map((fixture) => ({
    name: fixture.name,
    expected: fixture.expected,
    actual: fixture.assessment.status,
    score: fixture.assessment.score,
  }));

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
