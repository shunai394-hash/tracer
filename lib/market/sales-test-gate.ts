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

// The Sales Test Gate is the only automated path allowed to set
// shop_listings.published = true. Every listing it publishes carries this
// marker twice: in pipeline_reason (with stage PUBLISHED / status published)
// and in selection_reasons. Downstream stages may legitimately move the
// pipeline_* columns on (e.g. BASE_PUBLISHED), so selection_reasons is the
// durable proof; new BASE items and NEWFIND delivery require it.
export const SALES_TEST_GATE_PASSED = "sales_test_gate_passed";

export type SalesTestGateRow = {
  published?: unknown;
  pipeline_stage?: unknown;
  pipeline_status?: unknown;
  pipeline_reason?: unknown;
  selection_reasons?: unknown;
};

/** True only for a listing the Sales Test Gate published and that is still public. */
export function hasPassedSalesTestGate(row: SalesTestGateRow): boolean {
  if (row.published !== true) return false;
  if (Array.isArray(row.selection_reasons) && row.selection_reasons.includes(SALES_TEST_GATE_PASSED)) {
    return true;
  }
  return (
    // BASE publication advances the stage but keeps the gate reason.
    (row.pipeline_stage === "PUBLISHED" || row.pipeline_stage === "BASE_PUBLISHED") &&
    row.pipeline_status === "published" &&
    row.pipeline_reason === SALES_TEST_GATE_PASSED
  );
}
