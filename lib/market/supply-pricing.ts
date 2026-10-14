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
  const existingValid = existing !== null && Number.isFinite(existing) && existing > 0;
  const { sourceCost, shippingCost, sourceFxRateToSelling } = inputs;
  if (
    sourceCost === null || !Number.isFinite(sourceCost) || sourceCost <= 0 ||
    shippingCost === null || !Number.isFinite(shippingCost) || shippingCost < 0 ||
    sourceFxRateToSelling === null || !Number.isFinite(sourceFxRateToSelling) || sourceFxRateToSelling <= 0
  ) return existingValid ? Math.ceil(existing) : null;

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
  const minimumPrice = Math.ceil((landedCostJpy / denominator) / 100) * 100;
  return existingValid ? Math.max(Math.ceil(existing), minimumPrice) : minimumPrice;
}


export function resolveSupplierFxRateToJpy(args: {
  sourceCurrency: string | null;
  metadataFxRate: number | null;
  metadataFxSourceCurrency?: string | null;
  metadataFxTargetCurrency?: string | null;
  observedUsdToJpyRate: number | null;
}): number | null {
  const currency = args.sourceCurrency?.trim().toUpperCase() ?? "";
  if (!currency) return null;
  if (currency === "JPY") return 1;
  if (currency === "USD") {
    const explicit = args.metadataFxRate;
    if (explicit !== null && Number.isFinite(explicit) && explicit > 0) return explicit;
    const observed = args.observedUsdToJpyRate;
    return observed !== null && Number.isFinite(observed) && observed > 0 ? observed : null;
  }
  const metadataSource = args.metadataFxSourceCurrency?.trim().toUpperCase() ?? "";
  const metadataTarget = args.metadataFxTargetCurrency?.trim().toUpperCase() ?? "";
  const explicit = args.metadataFxRate;
  if (
    metadataSource === currency && metadataTarget === "JPY" &&
    explicit !== null && Number.isFinite(explicit) && explicit > 0
  ) return explicit;
  return null;
}
