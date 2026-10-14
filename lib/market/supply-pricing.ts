export type SupplyPriceInputs = {
  existingSellingPriceJpy: number | null;
  sourceCost: number | null;
  shippingCost: number | null;
  sourceFxRateToSelling: number | null;
  platformFeeRate: number;
  paymentFeeRate: number;
  advertisingAllowanceRate: number;
  returnRefundReserveRate: number;
  fxReserveRate: number;
  targetContributionMargin?: number;
};

export function calculateSupplySellingPriceJpy(inputs: SupplyPriceInputs): number | null {
  const existing = inputs.existingSellingPriceJpy;
  if (existing !== null && Number.isFinite(existing) && existing > 0) return Math.ceil(existing);
  const { sourceCost, shippingCost, sourceFxRateToSelling } = inputs;
  if (
    sourceCost === null || !Number.isFinite(sourceCost) || sourceCost <= 0 ||
    shippingCost === null || !Number.isFinite(shippingCost) || shippingCost < 0 ||
    sourceFxRateToSelling === null || !Number.isFinite(sourceFxRateToSelling) || sourceFxRateToSelling <= 0
  ) return null;

  const retainedAfterFees = 1
    - inputs.platformFeeRate
    - inputs.paymentFeeRate
    - inputs.advertisingAllowanceRate
    - inputs.returnRefundReserveRate
    - inputs.fxReserveRate;
  const targetMargin = inputs.targetContributionMargin ?? 0.20;
  const denominator = retainedAfterFees - targetMargin;
  const landedCostJpy = (sourceCost + shippingCost) * sourceFxRateToSelling;
  if (!Number.isFinite(landedCostJpy) || landedCostJpy <= 0 || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.ceil((landedCostJpy / denominator) / 100) * 100;
}
