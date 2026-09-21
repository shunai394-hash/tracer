export type AccountFitInput = {
  category: string | null;
  historicalCategoryOrders: number | null;
  historicalCategoryRevenue: number | null;
  historicalCvr: number | null;
  weightKg: number | null;
  hazardous: boolean | null;
  restricted: boolean | null;
  shippable: boolean | null;
};

export type AccountFitResult = {
  score: number | null;
  confidence: number;
  risks: string[];
  evidence: Record<string, unknown>;
};

export function evaluateAccountFit(input: AccountFitInput): AccountFitResult {
  const risks: string[] = [];
  const parts: Array<{ score: number; confidence: number }> = [];

  if (input.historicalCategoryOrders !== null && input.historicalCategoryOrders > 0) {
    parts.push({
      score: Math.min(100, 50 + input.historicalCategoryOrders * 5),
      confidence: 0.7,
    });
  }
  if (input.historicalCvr !== null) {
    parts.push({
      score: Math.max(0, Math.min(100, input.historicalCvr * 100)),
      confidence: 0.65,
    });
  }
  if (input.weightKg !== null && input.weightKg >= 10) {
    risks.push("large_item_shipping");
    parts.push({ score: 30, confidence: 0.6 });
  }
  if (input.hazardous === true) {
    risks.push("hazardous");
    parts.push({ score: 10, confidence: 0.8 });
  }
  if (input.restricted === true) {
    risks.push("compliance");
    parts.push({ score: 5, confidence: 0.85 });
  }
  if (input.shippable === false) {
    risks.push("not_shippable");
    parts.push({ score: 0, confidence: 0.85 });
  }

  if (parts.length === 0) {
    return {
      score: null,
      confidence: 0,
      risks,
      evidence: {
        note: "no_account_history_or_constraints_observed",
        category: input.category,
      },
    };
  }

  const score =
    parts.reduce((sum, part) => sum + part.score, 0) / parts.length;
  const confidence =
    parts.reduce((sum, part) => sum + part.confidence, 0) / parts.length;

  return {
    score: Number(Math.max(0, Math.min(100, score)).toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    risks,
    evidence: {
      historical_category_orders: input.historicalCategoryOrders,
      historical_cvr: input.historicalCvr,
      weight_kg: input.weightKg,
      hazardous: input.hazardous,
      restricted: input.restricted,
    },
  };
}

export function verifyAccountFitInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const unknown = evaluateAccountFit({
    category: "automobile",
    historicalCategoryOrders: null,
    historicalCategoryRevenue: null,
    historicalCvr: null,
    weightKg: null,
    hazardous: null,
    restricted: null,
    shippable: null,
  });
  const experienced = evaluateAccountFit({
    category: "automobile",
    historicalCategoryOrders: 8,
    historicalCategoryRevenue: 1200,
    historicalCvr: 0.04,
    weightKg: null,
    hazardous: null,
    restricted: null,
    shippable: true,
  });

  const cases = [
    {
      name: "no_history_is_unknown_not_experienced",
      expected: true,
      actual: unknown.score === null && unknown.confidence === 0,
    },
    {
      name: "observed_category_sales_raise_fit",
      expected: true,
      actual: experienced.score !== null && experienced.score > 40,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
