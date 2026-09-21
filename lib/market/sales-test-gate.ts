export type SalesTestGateInput = {
  rank: number | null;
  title: string | null;
  sellingPrice: number | null;
  identityLinked: boolean;
  identityMethod: string | null;
  sourceCost: number | null;
  shippingCost: number | null;
  trackingAvailable: boolean | null;
  apiAvailable: boolean | null;
  profitCalculable: boolean;
  shippingUnknown: boolean;
  contributionProfit: number | null;
  currencyMismatch: boolean;
};

export function evaluateSalesTestGate(input: SalesTestGateInput): {
  eligible: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (input.rank === null) reasons.push("rank_unknown");
  if (!input.title) reasons.push("title_unknown");
  if (input.sellingPrice === null) reasons.push("selling_price_unknown");
  if (!input.identityLinked || input.identityMethod === "title") {
    reasons.push("identity_not_confirmed");
  }
  if (input.sourceCost === null) reasons.push("source_cost_unknown");
  if (input.shippingCost === null || input.shippingUnknown) {
    reasons.push("shipping_unknown");
  }
  if (input.trackingAvailable !== true) reasons.push("tracking_unknown");
  if (input.apiAvailable !== true) reasons.push("supplier_api_unknown");
  if (!input.profitCalculable || input.currencyMismatch) reasons.push("profit_unknown");
  if (input.contributionProfit !== null && input.contributionProfit <= 0) {
    reasons.push("profit_not_positive");
  }

  return { eligible: reasons.length === 0, reasons };
}

export function verifySalesTestGateInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const ready = evaluateSalesTestGate({
    rank: 1,
    title: "Floor Mat",
    sellingPrice: 3980,
    identityLinked: true,
    identityMethod: "jan",
    sourceCost: 12,
    shippingCost: 4,
    trackingAvailable: true,
    apiAvailable: true,
    profitCalculable: true,
    shippingUnknown: false,
    contributionProfit: 8,
    currencyMismatch: false,
  });
  const titleOnly = evaluateSalesTestGate({
    rank: 1,
    title: "Floor Mat",
    sellingPrice: 3980,
    identityLinked: false,
    identityMethod: "title",
    sourceCost: 12,
    shippingCost: 4,
    trackingAvailable: true,
    apiAvailable: true,
    profitCalculable: true,
    shippingUnknown: false,
    contributionProfit: 8,
    currencyMismatch: false,
  });

  const cases = [
    {
      name: "complete_observed_product_is_eligible",
      expected: true,
      actual: ready.eligible,
    },
    {
      name: "title_only_identity_is_not_eligible",
      expected: true,
      actual: titleOnly.eligible === false &&
        titleOnly.reasons.includes("identity_not_confirmed"),
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
