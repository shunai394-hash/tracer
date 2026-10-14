import type { CurrencyConfidence, ProvenanceEntry } from "@/lib/domain/types";
import { calculateLandedEconomics } from "@/lib/suppliers/landed-economics";
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
  /** Observed multiplier from source currency into selling currency. */
  sourceFxRateToSelling?: number | null;
  sourceFxRateSource?: string | null;
  /** Publication selectors must set this to avoid treating unknown domestic delivery as free. */
  requireDomesticShipping?: boolean;
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
      args.internationalShipping == null || (args.requireDomesticShipping === true && args.domesticShipping == null),
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

  const fxRate = args.sourceFxRateToSelling ?? null;
  const currenciesMatch = sellingCurrency === sourceCurrency;
  if (!currenciesMatch && (!fxRate || !Number.isFinite(fxRate) || fxRate <= 0)) {
    return unknown("currency_mismatch_no_observed_fx");
  }

  const convertedSourceCost =
    currenciesMatch ? args.sourceCost : args.sourceCost * (fxRate as number);

  if (fxRate && !currenciesMatch) {
    provenance.push({
      field: "source_fx_rate_to_selling",
      kind: "observed",
      source: args.sourceFxRateSource ?? "observed_fx_rate",
      value: fxRate,
      note: `${sourceCurrency}->${sellingCurrency}`,
    });
  }

  // Keep product discovery moving when a supplier quote is unavailable:
  // price in a conservative freight reserve and re-quote asynchronously.
  // These are explicit operating assumptions, never represented as observed quotes.
  const shippingUnknown = args.internationalShipping == null ||
    (args.requireDomesticShipping === true && args.domesticShipping == null);
  const shippingCurrency = args.shippingCurrency?.trim().toUpperCase() ?? null;
  const shippingCurrenciesMatchSelling = shippingCurrency === sellingCurrency;
  const shippingCurrenciesMatchSource = shippingCurrency === sourceCurrency;
  const shippingFxRate = shippingCurrenciesMatchSelling
    ? 1
    : shippingCurrenciesMatchSource
      ? (currenciesMatch ? 1 : fxRate)
      : null;

  if (args.internationalShipping != null && !shippingCurrency) {
    return unknown("shipping_currency_missing");
  }
  if (args.internationalShipping != null && shippingFxRate === null) {
    return unknown("shipping_currency_mismatch_no_observed_fx");
  }

  const convertedInternationalShipping = args.internationalShipping == null
    ? null
    : args.internationalShipping * (shippingFxRate as number);
  const minimumFreightReserve = sellingCurrency === "JPY" ? 800 : 8;
  const internationalShipping = convertedInternationalShipping ??
    Math.ceil(Math.max(minimumFreightReserve, convertedSourceCost * 0.35));
  const domesticShipping = args.domesticShipping ??
    (args.requireDomesticShipping === true ? (sellingCurrency === "JPY" ? 600 : 6) : 0);

  if (shippingFxRate && !shippingCurrenciesMatchSelling) {
    provenance.push({
      field: "shipping_fx_rate_to_selling",
      kind: "observed",
      source: args.sourceFxRateSource ?? "observed_fx_rate",
      value: shippingFxRate,
      note: `${shippingCurrency}->${sellingCurrency}`,
    });
  }
  if (args.internationalShipping == null) {
    provenance.push({
      field: "international_shipping_reserve",
      kind: "assumption",
      value: internationalShipping,
      note: "estimated_at_35_percent_of_supplier_cost_with_minimum_reserve; refresh_actual_quote_and_reprice",
    });
  }
  if (args.requireDomesticShipping === true && args.domesticShipping == null) {
    provenance.push({
      field: "domestic_shipping_reserve",
      kind: "assumption",
      value: domesticShipping,
      note: "temporary_domestic_delivery_reserve; refresh_actual_quote_and_reprice",
    });
  }

  const advertisingAllowance = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.advertising_allowance_rate,
  );
  const returnRefundReserve = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.return_refund_reserve_rate,
  );
  const fxReserve = roundMoney(
    args.sellingPrice * PROFIT_ASSUMPTIONS.fx_reserve_rate,
  );

  // One shared JPY economics calculator now owns landed cost, platform/payment
  // fees, and contribution profit. Currency conversion and shipping evidence
  // are resolved above; unknown costs still fail closed before reaching here.
  const economics = calculateLandedEconomics({
    sellingPriceJpy: args.sellingPrice,
    supplierCostJpy: convertedSourceCost,
    japanShippingJpy: internationalShipping + domesticShipping,
    platformFeeRate: PROFIT_ASSUMPTIONS.platform_fee_rate,
    paymentFeeRate: PROFIT_ASSUMPTIONS.payment_fee_rate,
    fixedFeesJpy: 0,
    otherKnownCostsJpy: advertisingAllowance + returnRefundReserve + fxReserve,
  });
  if (!economics.ready) return unknown(economics.reason ?? "landed_economics_not_ready");

  const platformFee = economics.platformFeeJpy!;
  const paymentFee = economics.paymentFeeJpy!;
  const contributionProfit = roundMoney(economics.contributionProfitJpy!);
  const contributionMargin = roundMoney((economics.contributionMargin ?? 0) * 100);
  const totalCost = roundMoney(args.sellingPrice - contributionProfit);
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
      value: { internationalShippingReserve: internationalShipping, domesticShippingReserve: domesticShipping },
      note: "shipping_quote_missing_but_conservative_reserve_included_in_profit; quote_refresh_required",
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
      amount: convertedSourceCost,
      currency: sellingCurrency,
      kind: "observed",
    },
    {
      key: "international_shipping",
      label: "国際送料",
      amount: internationalShipping,
      currency: sellingCurrency,
      kind: args.internationalShipping == null ? "assumption" : "observed",
      note: args.internationalShipping == null ? "temporary_freight_reserve_quote_refresh_required" : undefined,
    },
    {
      key: "domestic_shipping",
      label: "国内送料",
      amount: domesticShipping,
      currency: sellingCurrency,
      kind: args.domesticShipping == null && args.requireDomesticShipping === true ? "assumption" : "observed",
      note: args.domesticShipping == null && args.requireDomesticShipping === true ? "temporary_delivery_reserve_quote_refresh_required" : undefined,
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
        ? "includes_conservative_shipping_reserve_quote_refresh_required"
        : fxRate && !currenciesMatch
          ? `includes_observed_fx_${sourceCurrency}_to_${sellingCurrency}`
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
    sourceCost: convertedSourceCost,
    internationalShipping,
    domesticShipping,
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

  const crossCurrencyShipping = simulateContributionProfit({
    sellingPrice: 12800,
    sellingCurrency: "JPY",
    sellingProvider: "marketplace",
    sourceCost: 3.38,
    sourceCurrency: "USD",
    sourceProvider: "cj",
    internationalShipping: 4.2,
    shippingCurrency: "USD",
    sourceFxRateToSelling: 150,
    sourceFxRateSource: "test",
    domesticShipping: 500,
    requireDomesticShipping: true,
  });

  const missingDomesticShipping = simulateContributionProfit({
    sellingPrice: 5000,
    sellingCurrency: "JPY",
    sellingCurrencyConfidence: "high",
    sellingProvider: "test",
    sourceCost: 1000,
    sourceCurrency: "JPY",
    sourceCurrencyConfidence: "high",
    sourceProvider: "test",
    internationalShipping: 300,
    domesticShipping: null,
    shippingCurrency: "JPY",
    requireDomesticShipping: true,
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
    {
      name: "unknown_domestic_shipping_blocks_publication_profit",
      expected: true,
      actual: !missingDomesticShipping.calculable && missingDomesticShipping.incalculableReason === "domestic_shipping_unknown" && missingDomesticShipping.shippingUnknown,
    },
    {
      name: "cross_currency_shipping_uses_source_fx",
      expected: true,
      actual:
        crossCurrencyShipping.calculable &&
        crossCurrencyShipping.internationalShipping === 630,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
