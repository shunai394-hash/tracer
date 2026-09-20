export type FailureReasonCode =
  | "demand_not_converted"
  | "price_too_high"
  | "shipping_too_expensive"
  | "creative_low_ctr"
  | "low_add_to_cart"
  | "low_checkout"
  | "supply_unavailable"
  | "margin_insufficient"
  | "compliance_risk"
  | "return_risk"
  | "identity_uncertain";

export function deriveFailureReasons(args: {
  impressions: number | null;
  clicks: number | null;
  addToCart: number | null;
  checkout: number | null;
  orders: number | null;
  contributionProfit: number | null;
  shippingCost: number | null;
  returns: number | null;
  identityUncertain?: boolean;
  supplyUnavailable?: boolean;
}): FailureReasonCode[] {
  const reasons: FailureReasonCode[] = [];

  if (args.identityUncertain) {
    reasons.push("identity_uncertain");
  }

  if (args.supplyUnavailable) {
    reasons.push("supply_unavailable");
  }

  if (
    args.impressions !== null &&
    args.impressions > 0 &&
    (args.clicks === null || args.clicks === 0)
  ) {
    reasons.push("creative_low_ctr");
  }

  if (
    args.clicks !== null &&
    args.clicks > 0 &&
    (args.addToCart === null || args.addToCart === 0)
  ) {
    reasons.push("low_add_to_cart");
  }

  if (
    args.addToCart !== null &&
    args.addToCart > 0 &&
    (args.checkout === null || args.checkout === 0)
  ) {
    reasons.push("low_checkout");
  }

  if (
    args.clicks !== null &&
    args.clicks > 0 &&
    (args.orders === null || args.orders === 0)
  ) {
    reasons.push("demand_not_converted");
  }

  if (args.contributionProfit !== null && args.contributionProfit < 0) {
    reasons.push("margin_insufficient");
  }

  if (args.returns !== null && args.returns > 0) {
    reasons.push("return_risk");
  }

  return reasons;
}
