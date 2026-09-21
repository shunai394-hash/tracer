export type RelatedProductCandidate = {
  id: string;
  productId: string;
  name: string;
  category: string | null;
  demandQuery: string | null;
};

export type RelatedProductResult = {
  method: "collaborative" | "attribute" | "none";
  items: RelatedProductCandidate[];
  evidence: Record<string, unknown>;
};

/**
 * Collaborative filtering is only used when enough purchase pairs exist.
 * Otherwise relate by category / demand query. Never invent co-purchase.
 */
export function recommendRelatedProducts(args: {
  category: string | null;
  demandQuery: string | null;
  candidates: RelatedProductCandidate[];
  purchasePairs: number;
}): RelatedProductResult {
  if (args.purchasePairs >= 20) {
    return {
      method: "collaborative",
      items: [],
      evidence: {
        note: "collaborative_eligible_but_pair_table_not_populated",
        purchase_pairs: args.purchasePairs,
      },
    };
  }

  const query = (args.demandQuery ?? "").toLowerCase();
  const category = (args.category ?? "").toLowerCase();
  const items = args.candidates
    .filter((item) => {
      const sameCategory =
        category && item.category && item.category.toLowerCase() === category;
      const sameDemand =
        query &&
        item.demandQuery &&
        item.demandQuery.toLowerCase() === query;
      return Boolean(sameCategory || sameDemand);
    })
    .slice(0, 5);

  return {
    method: items.length > 0 ? "attribute" : "none",
    items,
    evidence: {
      purchase_pairs: args.purchasePairs,
      used: "category_or_demand_query",
    },
  };
}

export function verifyRelatedProductInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const sparse = recommendRelatedProducts({
    category: "automobile",
    demandQuery: "toyota prius",
    purchasePairs: 0,
    candidates: [
      {
        id: "1",
        productId: "p1",
        name: "Prius mat",
        category: "automobile",
        demandQuery: "toyota prius",
      },
      {
        id: "2",
        productId: "p2",
        name: "Earbuds",
        category: "wireless earbuds",
        demandQuery: "earbuds",
      },
    ],
  });

  const cases = [
    {
      name: "no_purchase_history_uses_attributes",
      expected: true,
      actual: sparse.method === "attribute" && sparse.items.length === 1,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
