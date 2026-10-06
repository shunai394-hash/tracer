import { assessDemandRelevance } from "@/lib/intelligence/identity-confidence";
import { womenProductPriority } from "@/lib/intelligence/womens-priority";

export type SupplierSelectionRow = {
  title: string;
  sku: string | null;
  price: number | string | null;
  image_url: string | null;
  inventory: number | null;
  identifier: string | null;
  currency: string | null;
  available: boolean | null;
  orderable: boolean | null;
  tracking_available: boolean | null;
  supplier_name: string;
  supplier_product_id: string;
  supplier_query: string;
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
 * Rank supplier rows by demand relevance, identity completeness, and supply
 * data quality. Cheap price and high inventory do not raise the score.
 */
export function scoreDemandSupplierSelection(args: {
  demandQuery: string;
  demandCategory?: string | null;
  row: SupplierSelectionRow;
}): {
  relevance: ReturnType<typeof assessDemandRelevance>;
  selectionScore: number;
} {
  const title = String(args.row.title ?? "").replace(/\s+/g, " ").trim();

  const relevance = assessDemandRelevance({
    demandQuery: args.demandQuery,
    demandCategory: args.demandCategory,
    title,
    category: null,
    sku: args.row.sku,
    imageUrl: args.row.image_url
  });

  if (
    relevance.status === "rejected_noise" ||
    relevance.status === "identity_unconfirmed"
  ) {
    return { relevance, selectionScore: 0 };
  }

  let score = relevance.score * 80;
  const womenPriority = womenProductPriority({ title, category: null, query: args.demandQuery });
  score += womenPriority.bonus;

  if (args.row.image_url) score += 5;
  if (args.row.sku) score += 5;

  const price = number(args.row.price);
  if (price !== null && price > 0) score += 5;

  if (args.row.available) score += 5;
  if (args.row.orderable) score += 5;
  if (args.row.tracking_available) score += 5;

  if (typeof args.row.inventory === "number") {
    if (args.row.inventory <= 0) score -= 20;
  }

  return {
    relevance,
    selectionScore: Number(Math.max(0, Math.min(100, score)).toFixed(2)),
  };
}

export function verifySupplierSelectionInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const hair = scoreDemandSupplierSelection({
    demandQuery: "toyota prius",
    demandCategory: "automobile",
    row: {
      title: "Fashion Hair Clips Women Accessories",
      identifier: null,
      currency: "USD",
      available: true,
      orderable: true,
      tracking_available: true,
      supplier_name: "TEST",
      supplier_product_id: "HAIR-1",
      sku: "HAIR-1",
      price: 0.8,
      image_url: "https://example.com/hair.jpg",
      inventory: 9000,
      supplier_query: "car accessories",
    },
  });

  const mat = scoreDemandSupplierSelection({
    demandQuery: "toyota prius",
    demandCategory: "automobile",
    row: {
      title: "Toyota Prius Floor Mat",
      identifier: null,
      currency: "USD",
      available: true,
      orderable: true,
      tracking_available: true,
      supplier_name: "TEST",
      supplier_product_id: "PRI-MAT-01",
      sku: "PRI-MAT-01",
      price: 18,
      image_url: "https://example.com/mat.jpg",
      inventory: 40,
      supplier_query: "toyota prius floor mat",
    },
  });

  const cheapUnrelated = scoreDemandSupplierSelection({
    demandQuery: "toyota prius",
    demandCategory: "automobile",
    row: {
      title: "Watch Band Strap Accessories",
      identifier: null,
      currency: "USD",
      available: true,
      orderable: true,
      tracking_available: true,
      supplier_name: "TEST",
      supplier_product_id: "WATCH-1",
      sku: "WATCH-1",
      price: 0.3,
      image_url: "https://example.com/watch.jpg",
      inventory: 20000,
      supplier_query: "accessories",
    },
  });

  const cases = [
    {
      name: "unrelated_hair_is_not_selected",
      expected: true,
      actual:
        hair.selectionScore === 0 &&
        hair.relevance.status === "rejected_noise",
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






