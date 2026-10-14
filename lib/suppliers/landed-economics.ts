export type LandedEconomicsInput = {
  sellingPriceJpy: number | null;
  supplierCostJpy: number | null;
  japanShippingJpy: number | null;
  platformFeeRate: number | null;
  paymentFeeRate: number | null;
  fixedFeesJpy?: number | null;
  otherKnownCostsJpy?: number | null;
};

export type LandedEconomicsResult = {
  ready: boolean;
  reason: string | null;
  landedCostJpy: number | null;
  platformFeeJpy: number | null;
  paymentFeeJpy: number | null;
  contributionProfitJpy: number | null;
  contributionMargin: number | null;
};

const money = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const rate = (value: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1;

/**
 * Shared, fail-closed JPY economics calculation for all sales channels.
 * Unknown cost fields are never silently treated as zero.
 */
export function calculateLandedEconomics(input: LandedEconomicsInput): LandedEconomicsResult {
  const notReady = (reason: string): LandedEconomicsResult => ({
    ready: false, reason, landedCostJpy: null, platformFeeJpy: null,
    paymentFeeJpy: null, contributionProfitJpy: null, contributionMargin: null,
  });

  if (!money(input.sellingPriceJpy) || input.sellingPriceJpy <= 0) return notReady("selling_price_missing_or_invalid");
  if (!money(input.supplierCostJpy)) return notReady("supplier_cost_missing_or_invalid");
  if (!money(input.japanShippingJpy)) return notReady("japan_shipping_missing_or_invalid");
  if (!rate(input.platformFeeRate)) return notReady("platform_fee_rate_missing_or_invalid");
  if (!rate(input.paymentFeeRate)) return notReady("payment_fee_rate_missing_or_invalid");
  if (input.fixedFeesJpy !== undefined && input.fixedFeesJpy !== null && !money(input.fixedFeesJpy)) return notReady("fixed_fees_invalid");
  if (input.otherKnownCostsJpy !== undefined && input.otherKnownCostsJpy !== null && !money(input.otherKnownCostsJpy)) return notReady("other_costs_invalid");

  const fixedFees = input.fixedFeesJpy ?? 0;
  const otherCosts = input.otherKnownCostsJpy ?? 0;
  const platformFeeJpy = Math.ceil(input.sellingPriceJpy * input.platformFeeRate);
  const paymentFeeJpy = Math.ceil(input.sellingPriceJpy * input.paymentFeeRate);
  const landedCostJpy = input.supplierCostJpy + input.japanShippingJpy + fixedFees + otherCosts;
  const contributionProfitJpy = input.sellingPriceJpy - landedCostJpy - platformFeeJpy - paymentFeeJpy;

  return {
    ready: true,
    reason: contributionProfitJpy > 0 ? null : "contribution_profit_not_positive",
    landedCostJpy,
    platformFeeJpy,
    paymentFeeJpy,
    contributionProfitJpy,
    contributionMargin: contributionProfitJpy / input.sellingPriceJpy,
  };
}
