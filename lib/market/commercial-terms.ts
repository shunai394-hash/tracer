/** How long an observed FX quote may be used to convert cost into JPY. */
export const COMMERCIAL_FX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CommercialTermsInput = {
  sellingCurrency: unknown;
  sourceCurrency: unknown;
  sourceCost: unknown;
  shippingCost: unknown;
  sellingPrice: unknown;
  fxRate: unknown;
  fxObservedAt: unknown;
  nowMs?: number;
  maxAgeMs?: number;
};

export type CommercialTerms = {
  currencyMismatch: boolean;
  profitCalculable: boolean;
  contributionProfit: number | null;
  reasons: string[];
};

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function currencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

function observedAtMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Selling prices are JPY. A non-JPY source cost is converted only with a
 * finite, unexpired FX quote. Stored profit is not trusted, and null is never
 * stringified into a currency code.
 */
export function assessCommercialTerms(input: CommercialTermsInput): CommercialTerms {
  const reasons: string[] = [];
  const selling = currencyCode(input.sellingCurrency);
  const source = currencyCode(input.sourceCurrency);
  const price = finiteNumber(input.sellingPrice);
  const sourceCost = finiteNumber(input.sourceCost);
  const shippingCost = finiteNumber(input.shippingCost);

  if (selling !== "JPY") reasons.push("currency_not_jpy");
  if (!source) reasons.push("source_currency_unknown");
  if (price === null || price <= 0) reasons.push("selling_price_invalid");
  if (sourceCost === null || sourceCost < 0) reasons.push("source_cost_unknown");
  if (shippingCost === null || shippingCost < 0) reasons.push("shipping_unknown");

  let rate: number | null = null;
  if (selling === "JPY" && source === "JPY") {
    rate = 1;
  } else if (selling === "JPY" && source) {
    const fxRate = finiteNumber(input.fxRate);
    const observedAt = observedAtMs(input.fxObservedAt);
    const now = input.nowMs ?? Date.now();
    const maxAge = input.maxAgeMs ?? COMMERCIAL_FX_MAX_AGE_MS;
    if (fxRate === null || fxRate <= 0) reasons.push("fx_unavailable");
    else if (observedAt === null) reasons.push("fx_observed_at_missing");
    else if (now - observedAt > maxAge || observedAt > now + 5 * 60 * 1000) reasons.push("fx_stale");
    else rate = fxRate;
  }

  const contributionProfit = rate !== null && price !== null && price > 0 && sourceCost !== null && sourceCost >= 0 && shippingCost !== null && shippingCost >= 0
    ? price - (sourceCost + shippingCost) * rate
    : null;
  const currencyMismatch = reasons.some((reason) => reason !== "selling_price_invalid" && reason !== "source_cost_unknown" && reason !== "shipping_unknown");
  return {
    currencyMismatch,
    profitCalculable: contributionProfit !== null && Number.isFinite(contributionProfit),
    contributionProfit: contributionProfit !== null && Number.isFinite(contributionProfit) ? contributionProfit : null,
    reasons,
  };
}

export function currencyMismatchFromProfitReason(reason: string | null | undefined): boolean {
  return reason === "currency_mismatch_no_observed_fx"
    || reason === "shipping_currency_mismatch_no_observed_fx"
    || reason === "currency_missing"
    || reason === "currency_confidence_too_low";
}
