import "server-only";

import { classifyDemandIntent } from "@/lib/intelligence/classify-demand-intent";

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
  "wireless earbuds": [
    "airpods",
    "air pods",
    "earbuds",
    "wireless earbuds",
    "true wireless",
    "bluetooth earbuds",
  ],
  headphones: [
    "headphones",
    "wireless headphones",
    "noise cancelling",
    "noise-canceling",
  ],
  smartphone: [
    "iphone",
    "ipad",
    "galaxy",
    "pixel",
    "android phone",
    "smartphone",
    "mobile phone",
  ],
  skincare: [
    "serum",
    "moisturizer",
    "face cream",
    "skincare",
    "skin care",
    "sunscreen",
  ],
  sneakers: [
    "sneakers",
    "running shoes",
    "trainers",
    "shoes",
  ],
  automobile: [
    "car",
    "automobile",
    "vehicle",
    "toyota",
    "prius",
    "honda",
    "nissan",
    "mazda",
  ],
};

const NON_PRODUCT_PATTERNS = [
  /weather/i,
  /forecast/i,
  /news/i,
  /election/i,
  /stock market/i,
  /exchange rate/i,
  /horoscope/i,
  /recipe/i,
  /restaurant/i,
  /movie/i,
  /anime episode/i,
  /sports score/i,
];

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isBrokenText(value: string): boolean {
  return (
    value.includes("\uFFFD") ||
    /(?:繝ｻ繝ｻ繝ｻ|繝ｻ繝ｻ繝ｻ|繝ｻ繝ｻ・ｽ・｢.|繝ｻ繝ｻ・ｽ・･.|繝ｻ繝ｻ・ｽ・ｦ.|繝ｻ繝ｻ・ｽ・ｧ.|繝ｻ繝ｻ・ｽ・ｩ.|繝ｻ繝ｻ・ｽ・ｨ.|繝ｻ繝ｻ・ｽ・ｪ.|繝ｻ繝ｻ・ｽ・ｫ.|繝ｻ繝ｻ・ｽ・ｬ.|繝ｻ繝ｻ・ｽ・ｭ.|繝ｻ繝ｻ・ｽ・ｮ.|繝ｻ繝ｻ・ｽ・ｯ.|繝ｻ繝ｻ・ｽ・ｰ.|繝ｻ繝ｻ・ｽ・ｱ.|繝ｻ繝ｻ・ｽ・ｲ.|繝ｻ繝ｻ・ｽ・ｳ.|繝ｻ繝ｻ・ｽ・ｴ.|繝ｻ繝ｻ・ｽ・ｵ.|繝ｻ繝ｻ・ｽ・ｶ.|繝ｻ繝ｻ・ｽ・ｸ.|繝ｻ繝ｻ・ｽ・ｹ.|繝ｻ繝ｻ・ｽ・ｺ.|繝ｻ繝ｻ・ｽ・ｻ.|繝ｻ繝ｻ・ｽ・ｼ.|繝ｻ繝ｻ・ｽ・ｽ.|繝ｻ繝ｻ・ｽ・ｾ.)/.test(
      value,
    )
  );
}

function detectProductIntent(query: string): ProductIntent {
  const normalized = normalize(query);

  if (!normalized) {
    return {
      isProduct: false,
      category: null,
      reason: "empty_query",
    };
  }

  if (NON_PRODUCT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      isProduct: false,
      category: null,
      reason: "non_product_pattern",
    };
  }

  for (const [category, keywords] of Object.entries(
    PRODUCT_CATEGORY_KEYWORDS,
  )) {
    const matchedKeyword = keywords.find((keyword) =>
      normalized.includes(normalize(keyword)),
    );

    if (matchedKeyword) {
      return {
        isProduct: true,
        category,
        reason: `product_keyword:${matchedKeyword}`,
      };
    }
  }

  return {
    isProduct: false,
    category: null,
    reason: "no_product_signal",
  };
}

function productMatchesQuery(
  query: string,
  productName: string,
): boolean {
  const normalizedQuery = normalize(query);
  const normalizedProduct = normalize(productName);

  if (!normalizedQuery || !normalizedProduct) return false;

  if (
    normalizedQuery === normalizedProduct ||
    normalizedQuery.includes(normalizedProduct) ||
    normalizedProduct.includes(normalizedQuery)
  ) {
    return true;
  }

  const aliases: Record<string, string[]> = {
    "Apple AirPods Pro 3": [
      "airpods",
      "airpods pro",
      "驛｢・ｧ繝ｻ・ｨ驛｢・ｧ繝ｻ・｢驛｢譎・ｺ｢郢晢ｽ｣驛｢・ｧ繝ｻ・ｺ",
      "airpods pro 3",
    ],
    "Samsung Galaxy Buds4": [
      "galaxy buds",
      "galaxy buds4",
      "驛｢・ｧ繝ｻ・ｮ驛｢譎｢・ｽ・｣驛｢譎｢・ｽ・ｩ驛｢・ｧ繝ｻ・ｯ驛｢・ｧ繝ｻ・ｷ驛｢譎｢・ｽ・ｼ驛｢譎√・郢晢ｽ｣驛｢・ｧ繝ｻ・ｺ",
    ],
    "Google Pixel Buds 2a True Wireless Earbuds": [
      "pixel buds",
      "pixel buds 2a",
      "驛｢譎・ｱ堤ｸｺ驢搾ｽｹ・ｧ繝ｻ・ｻ驛｢譎｢・ｽ・ｫ驛｢譎√・郢晢ｽ｣驛｢・ｧ繝ｻ・ｺ",
    ],
  };

  const productAliases = aliases[productName] ?? [];

  return productAliases.some((alias) =>
    normalizedQuery.includes(normalize(alias)),
  );
}

export async function matchDemandProductsByCategory(): Promise<DemandProductMatchResult> {
  const supabase = createSupabaseAdminClient();

  const { data: demandRows, error: demandError } = await supabase
    .from("demand_observations")
    .select("id, metadata, value, observed_at")
    .is("product_id", null)
    .eq("signal_type", "search_volume")
    .order("observed_at", { ascending: false });

  if (demandError) {
    throw new Error(demandError.message);
  }

  const { data: products, error: productError } = await supabase
    .from("products")
    .select("id, canonical_name");

  if (productError) {
    throw new Error(productError.message);
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

    const metadata =
      demand.metadata &&
      typeof demand.metadata === "object" &&
      !Array.isArray(demand.metadata)
        ? (demand.metadata as Record<string, unknown>)
        : {};

    const invalid =
      metadata.invalid === true ||
      metadata.invalid_reason === "unrecoverable_encoding";

    if (invalid) {
      skippedInvalid += 1;
      continue;
    }

    const query =
      typeof metadata.query === "string"
        ? metadata.query.trim()
        : "";

    if (!query || isBrokenText(query)) {
      skippedInvalid += 1;
      continue;
    }

    let intent = detectProductIntent(query);

    if (!intent.isProduct && intent.reason === "no_product_signal") {
      try {
        const aiIntent = await classifyDemandIntent(query);

        if (aiIntent.is_product_demand) {
          intent = {
            isProduct: true,
            category: aiIntent.category ?? null,
            reason: `gemini:${aiIntent.reason}`,
          };
        }
      } catch (error) {
        console.error("[demand-gemini-classify]", {
          query,
          error,
        });
      }
    }

    if (!intent.isProduct) {
      intentNonProduct += 1;
      continue;
    }

    intentProduct += 1;

    let rowMatched = false;

    for (const product of products ?? []) {
      if (!productMatchesQuery(query, product.canonical_name)) {
        continue;
      }

      const { error: insertError } = await supabase
        .from("demand_product_matches")
        .upsert(
          {
            demand_observation_id: demand.id,
            product_id: product.id,
            match_method: "keyword",
            match_score: 0.9,
            rationale: `Product intent query "${query}" matched "${product.canonical_name}" (${intent.reason})`,
          },
          {
            onConflict: "demand_observation_id,product_id",
            ignoreDuplicates: true,
          },
        );

      if (insertError) {
        throw new Error(
          `Failed to insert demand product match: ${insertError.message}`,
        );
      }

      matched += 1;
      rowMatched = true;
    }

    if (rowMatched) {
      continue;
    }

    /*
     * Product-related demand exists, but no existing catalog product matched.
     * Preserve the raw demand observation and create/reuse one discovery
     * candidate per query. No demand score is copied here.
     */
    const { data: existingCandidate, error: candidateLookupError } =
      await supabase
        .from("demand_product_candidates")
        .select("id, demand_observation_id, query")
        .eq("query", query)
        .maybeSingle();

    console.log("[demand-candidate-lookup]", {
      demandId: demand.id,
      query,
      existingCandidate,
    });
    if (candidateLookupError) {
      throw new Error(
        `Failed to lookup demand product candidate: ${candidateLookupError.message}`,
      );
    }

    if (existingCandidate) {
      candidatesExisting += 1;
      continue;
    }

    const source =
      typeof metadata.provider === "string"
        ? metadata.provider
        : "google_trends";

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
        console.log("[candidate-insert-duplicate]", {
          demandId: demand.id,
          query,
          message: candidateInsertError.message,
          details: candidateInsertError.details,
          hint: candidateInsertError.hint,
        });
        candidatesExisting += 1;
        continue;
      }

      throw new Error(
        `Failed to insert demand product candidate: ${candidateInsertError.message}`,
      );
    }

    candidatesCreated += 1;
  }

  unmatched = intentProduct - matched;

  return {
    processed,
    intentProduct,
    intentNonProduct,
    matched,
    unmatched,
    candidatesCreated,
    candidatesExisting,
    skippedInvalid,
  };
}



