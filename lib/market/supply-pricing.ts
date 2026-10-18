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

/**
 * Never keep a stored price below the configured contribution-margin target
 * when landed cost, freight and FX are known. Preserve a higher chosen price.
 * If cost inputs are incomplete, return the stored price for diagnostics; the
 * publication gate independently blocks unknown economics.
 */
export function calculateSupplySellingPriceJpy(inputs: SupplyPriceInputs): number | null {
  const existing = inputs.existingSellingPriceJpy;
  const recommended = calculateRecommendedSupplySellingPriceJpy(inputs);
  if (existing !== null && Number.isFinite(existing) && existing > 0) {
    return recommended === null ? existing : Math.max(existing, recommended);
  }
  return recommended;
}

/** Estimate a suggested price from landed cost, fees and a target contribution margin. */
export function calculateRecommendedSupplySellingPriceJpy(inputs: SupplyPriceInputs): number | null {
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

export function resolveUnknownShippingAllowanceUsd(configured: string | null | undefined): number {
  if (configured == null || configured.trim() === "") return 15;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 500 ? Math.ceil(parsed * 100) / 100 : 15;
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
