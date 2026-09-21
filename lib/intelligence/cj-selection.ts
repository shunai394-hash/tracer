import { assessDemandRelevance } from "@/lib/intelligence/identity-confidence";

export type CJSelectionRow = {
  title: string;
  sku: string | null;
  price: number | string | null;
  image_url: string | null;
  inventory: number | null;
  listed_num: number | null;
  product_type: string | null;
  sale_status: string | null;
  cj_query: string;
};

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Rank CJ rows by demand relevance, identity completeness, and supply
 * data quality. Cheap price and high inventory do not raise the score.
 */
export function scoreDemandCJSelection(args: {
  demandQuery: string;
  demandCategory?: string | null;
  row: CJSelectionRow;
}): {
  relevance: ReturnType<typeof assessDemandRelevance>;
  selectionScore: number;
} {
  const title = String(args.row.title ?? "").replace(/\s+/g, " ").trim();
  const relevance = assessDemandRelevance({
    demandQuery: args.demandQuery,
    demandCategory: args.demandCategory,
    title,
    category: args.row.product_type,
    sku: args.row.sku,
    imageUrl: args.row.image_url,
    cjQuery: args.row.cj_query,
  });

  if (
    relevance.status === "rejected_noise" ||
    relevance.status === "identity_unconfirmed"
  ) {
    return { relevance, selectionScore: 0 };
  }

  let score = relevance.score * 80;

  if (args.row.image_url) score += 5;
  if (args.row.sku) score += 5;

  const price = number(args.row.price);
  if (price !== null && price > 0) score += 5;

  if (args.row.sale_status) score += 5;

  if (typeof args.row.inventory === "number") {
    if (args.row.inventory <= 0) score -= 20;
  }

  return {
    relevance,
    selectionScore: Number(Math.max(0, Math.min(100, score)).toFixed(2)),
  };
}

export function verifyCJSelectionInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const hair = scoreDemandCJSelection({
    demandQuery: "toyota prius",
    demandCategory: "automobile",
    row: {
      title: "Fashion Hair Clips Women Accessories",
      sku: "HAIR-1",
      price: 0.8,
      image_url: "https://example.com/hair.jpg",
      inventory: 9000,
      listed_num: 400,
      product_type: "hair accessories",
      sale_status: "onSale",
      cj_query: "car accessories",
    },
  });

  const mat = scoreDemandCJSelection({
    demandQuery: "toyota prius",
    demandCategory: "automobile",
    row: {
      title: "Toyota Prius Floor Mat",
      sku: "PRI-MAT-01",
      price: 18,
      image_url: "https://example.com/mat.jpg",
      inventory: 40,
      listed_num: 2,
      product_type: "automobile",
      sale_status: "onSale",
      cj_query: "toyota prius floor mat",
    },
  });

  const cheapUnrelated = scoreDemandCJSelection({
    demandQuery: "toyota prius",
    demandCategory: "automobile",
    row: {
      title: "Watch Band Strap Accessories",
      sku: "WATCH-1",
      price: 0.3,
      image_url: "https://example.com/watch.jpg",
      inventory: 20000,
      listed_num: 800,
      product_type: "watch accessories",
      sale_status: "onSale",
      cj_query: "accessories",
    },
  });

  const cases = [
    {
      name: "unrelated_hair_is_not_selected",
      expected: true,
      actual: hair.selectionScore === 0 && hair.relevance.status === "rejected_noise",
    },
    {
      name: "relevant_mat_outranks_cheap_noise",
      expected: true,
      actual:
        mat.selectionScore > 0 &&
        mat.selectionScore > cheapUnrelated.selectionScore &&
        cheapUnrelated.selectionScore === 0,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
