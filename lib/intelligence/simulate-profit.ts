import type { CurrencyConfidence, ProvenanceEntry } from "@/lib/domain/types";
import {
  assessCurrencyConfidence,
  isCurrencyReliable,
} from "@/lib/intelligence/currency-confidence";

export const PROFIT_ASSUMPTIONS = {
  platform_fee_rate: 0.1,
  payment_fee_rate: 0.036,
  advertising_allowance_rate: 0.15,
  return_refund_reserve_rate: 0.05,
  fx_reserve_rate: 0.03,
} as const;

export type ProfitLine = {
  key: string;
  label: string;
  amount: number | null;
  currency: string | null;
  kind: "observed" | "assumption" | "unknown";
  note?: string;
};

export type ProfitSimulation = {
  calculable: boolean;
  currency: string | null;
  currencyConfidence: CurrencyConfidence;
  sellingPrice: number | null;
  sourceCost: number | null;
  internationalShipping: number | null;
  domesticShipping: number | null;
  platformFee: number | null;
  paymentFee: number | null;
  advertisingAllowance: number | null;
  returnRefundReserve: number | null;
  fxReserve: number | null;
  contributionProfit: number | null;
  contributionMargin: number | null;
  totalCost: number | null;
  roi: number | null;
  shippingUnknown: boolean;
  lines: ProfitLine[];
  provenance: ProvenanceEntry[];
  incalculableReason: string | null;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function simulateContributionProfit(args: {
  sellingPrice: number | null;
  sellingCurrency: string | null;
  sellingCurrencyConfidence?: CurrencyConfidence | null;
  sellingProvider?: string | null;
  sourceCost: number | null;
  sourceCurrency: string | null;
  sourceCurrencyConfidence?: CurrencyConfidence | null;
  sourceProvider?: string | null;
  internationalShipping?: number | null;
  domesticShipping?: number | null;
  shippingCurrency?: string | null;
}): ProfitSimulation {
  const sellingAssessment = assessCurrencyConfidence({
    currency: args.sellingCurrency,
    price: args.sellingPrice,
    provider: args.sellingProvider,
  });
  const sourceAssessment = assessCurrencyConfidence({
    currency: args.sourceCurrency,
    price: args.sourceCost,
    provider: args.sourceProvider,
  });

  const sellingConfidence =
    args.sellingCurrencyConfidence ?? sellingAssessment.confidence;
  const sourceConfidence =
    args.sourceCurrencyConfidence ?? sourceAssessment.confidence;

  const provenance: ProvenanceEntry[] = [
    {
      field: "selling_price_currency_confidence",
      kind: "derived",
      source: args.sellingProvider ?? "product_offers",
      value: sellingConfidence,
      note: sellingAssessment.reasons.join(","),
    },
    {
      field: "source_cost_currency_confidence",
      kind: "derived",
      source: args.sourceProvider ?? "product_offers",
      value: sourceConfidence,
      note: sourceAssessment.reasons.join(","),
    },
  ];

  const unknown = (reason: string): ProfitSimulation => ({
    calculable: false,
    currency: null,
    currencyConfidence:
      sellingConfidence === "low" || sourceConfidence === "low"
        ? "low"
        : "unknown",
    sellingPrice: args.sellingPrice,
    sourceCost: args.sourceCost,
    internationalShipping: args.internationalShipping ?? null,
    domesticShipping: args.domesticShipping ?? null,
    platformFee: null,
    paymentFee: null,
    advertisingAllowance: null,
    returnRefundReserve: null,
    fxReserve: null,
    contributionProfit: null,
    contributionMargin: null,
    totalCost: null,
    roi: null,
    shippingUnknown:
      args.internationalShipping == null && args.domesticShipping == null,
    lines: [],
    provenance,
    incalculableReason: reason,
  });

  if (args.sellingPrice == null || args.sourceCost == null) {
    return unknown("missing_market_or_source_price");
  }

  if (!isCurrencyReliable(sellingConfidence) || !isCurrencyReliable(sourceConfidence)) {
    return unknown("currency_confidence_too_low");
  }

  const sellingCurrency = args.sellingCurrency?.trim().toUpperCase() ?? null;
  const sourceCurrency = args.sourceCurrency?.trim().toUpperCase() ?? null;

  if (!sellingCurrency || !sourceCurrency) {
    return unknown("currency_missing");
  }

  if (sellingCurrency !== sourceCurrency) {
    return unknown("currency_mismatch_no_observed_fx");
  }

  const shippingUnknown =
    args.internationalShipping == null && args.domesticShipping == null;
  const internationalShipping = args.internationalShipping ?? 0;
  const domesticShipping = args.domesticShipping ?? 0;

  if (!shippingUnknown && args.shippingCurrency) {
    const shippingCurrency = args.shippingCurrency.trim().toUpperCase();
    if (shippingCurrency !== sellingCurrency) {
      return unknown("shipping_currency_mismatch");
    }
  }

  const platformFee = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.platform_fee_rate,
  );
  const paymentFee = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.payment_fee_rate,
  );
  const advertisingAllowance = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.advertising_allowance_rate,
  );
  const returnRefundReserve = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.return_refund_reserve_rate,
  );
  const fxReserve = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.fx_reserve_rate,
  );

  const contributionProfit = roundMoney(
    args.sellingPrice -
      args.sourceCost -
      internationalShipping -
      domesticShipping -
      platformFee -
      paymentFee -
      advertisingAllowance -
      returnRefundReserve -
      fxReserve,
  );

  const contributionMargin = roundMoney(
    (contributionProfit / args.sellingPrice) * 100,
  );

  const totalCost = roundMoney(
    args.sourceCost +
      internationalShipping +
      domesticShipping +
      platformFee +
      paymentFee +
      advertisingAllowance +
      returnRefundReserve +
      fxReserve,
  );
  const roi = totalCost > 0 ? Number((contributionProfit / totalCost).toFixed(4)) : null;

  const weaker =
    sellingConfidence === "medium" || sourceConfidence === "medium"
      ? "medium"
      : "high";

  provenance.push(
    {
      field: "selling_price",
      kind: "observed",
      source: args.sellingProvider ?? "product_offers",
      value: args.sellingPrice,
    },
    {
      field: "source_cost",
      kind: "observed",
      source: args.sourceProvider ?? "product_offers",
      value: args.sourceCost,
    },
    {
      field: "platform_fee_rate",
      kind: "assumption",
      value: PROFIT_ASSUMPTIONS.platform_fee_rate,
      note: "operating_assumption_not_observed",
    },
    {
      field: "payment_fee_rate",
      kind: "assumption",
      value: PROFIT_ASSUMPTIONS.payment_fee_rate,
      note: "operating_assumption_not_observed",
    },
    {
      field: "advertising_allowance_rate",
      kind: "assumption",
      value: PROFIT_ASSUMPTIONS.advertising_allowance_rate,
      note: "operating_assumption_not_observed",
    },
    {
      field: "return_refund_reserve_rate",
      kind: "assumption",
      value: PROFIT_ASSUMPTIONS.return_refund_reserve_rate,
      note: "operating_assumption_not_observed",
    },
    {
      field: "fx_reserve_rate",
      kind: "assumption",
      value: PROFIT_ASSUMPTIONS.fx_reserve_rate,
      note: "operating_assumption_not_observed",
    },
  );

  if (shippingUnknown) {
    provenance.push({
      field: "shipping",
      kind: "derived",
      value: null,
      note: "shipping_not_observed_treated_as_unknown_not_zero_cost",
    });
  }

  const lines: ProfitLine[] = [
    {
      key: "selling_price",
      label: "販売価格",
      amount: args.sellingPrice,
      currency: sellingCurrency,
      kind: "observed",
    },
    {
      key: "source_cost",
      label: "仕入れ",
      amount: args.sourceCost,
      currency: sourceCurrency,
      kind: "observed",
    },
    {
      key: "international_shipping",
      label: "国際送料",
      amount: shippingUnknown ? null : internationalShipping,
      currency: sellingCurrency,
      kind: shippingUnknown ? "unknown" : "observed",
    },
    {
      key: "domestic_shipping",
      label: "国内送料",
      amount: shippingUnknown ? null : domesticShipping,
      currency: sellingCurrency,
      kind: shippingUnknown ? "unknown" : "observed",
    },
    {
      key: "platform_fee",
      label: "プラットフォーム手数料",
      amount: platformFee,
      currency: sellingCurrency,
      kind: "assumption",
      note: "operating_assumption",
    },
    {
      key: "payment_fee",
      label: "決済手数料",
      amount: paymentFee,
      currency: sellingCurrency,
      kind: "assumption",
      note: "operating_assumption",
    },
    {
      key: "advertising_allowance",
      label: "広告許容",
      amount: advertisingAllowance,
      currency: sellingCurrency,
      kind: "assumption",
      note: "operating_assumption",
    },
    {
      key: "return_refund_reserve",
      label: "返品引当",
      amount: returnRefundReserve,
      currency: sellingCurrency,
      kind: "assumption",
      note: "operating_assumption",
    },
    {
      key: "fx_reserve",
      label: "為替引当",
      amount: fxReserve,
      currency: sellingCurrency,
      kind: "assumption",
      note: "operating_assumption",
    },
    {
      key: "total_cost",
      label: "総コスト",
      amount: totalCost,
      currency: sellingCurrency,
      kind: "assumption",
    },
    {
      key: "contribution_profit",
      label: "想定粗利",
      amount: contributionProfit,
      currency: sellingCurrency,
      kind: "assumption",
      note: shippingUnknown
        ? "excludes_unknown_shipping"
        : "includes_assumed_fees",
    },
    {
      key: "roi",
      label: "ROI",
      amount: roi,
      currency: sellingCurrency,
      kind: "assumption",
    },
  ];

  return {
    calculable: true,
    currency: sellingCurrency,
    currencyConfidence: weaker,
    sellingPrice: args.sellingPrice,
    sourceCost: args.sourceCost,
    internationalShipping: shippingUnknown ? null : internationalShipping,
    domesticShipping: shippingUnknown ? null : domesticShipping,
    platformFee,
    paymentFee,
    advertisingAllowance,
    returnRefundReserve,
    fxReserve,
    contributionProfit,
    contributionMargin,
    totalCost,
    roi,
    shippingUnknown,
    lines,
    provenance,
    incalculableReason: null,
  };
}

export function verifyProfitInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const jpyLabeledUsd = simulateContributionProfit({
    sellingPrice: 12800,
    sellingCurrency: "USD",
    sellingProvider: "brightdata",
    sourceCost: 3.1,
    sourceCurrency: "USD",
    sourceProvider: "cj",
  });

  const healthy = simulateContributionProfit({
    sellingPrice: 29.99,
    sellingCurrency: "USD",
    sellingProvider: "brightdata",
    sourceCost: 3.38,
    sourceCurrency: "USD",
    sourceProvider: "cj",
  });

  const cases = [
    {
      name: "mislabeled_jpy_not_calculated",
      expected: false,
      actual: jpyLabeledUsd.calculable,
    },
    {
      name: "reliable_usd_calculated",
      expected: true,
      actual: healthy.calculable,
    },
    {
      name: "roi_unknown_when_not_calculable",
      expected: true,
      actual: jpyLabeledUsd.roi === null && jpyLabeledUsd.totalCost === null,
    },
    {
      name: "roi_computed_from_observed_costs",
      expected: true,
      actual:
        healthy.roi !== null &&
        healthy.totalCost !== null &&
        healthy.totalCost > 0,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
