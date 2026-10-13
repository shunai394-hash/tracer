export type SupplyShippingEvidence = {
  supplier: unknown;
  shipTo: unknown;
  shippingCost: unknown;
  verificationStatus: unknown;
  shippingStatus: unknown;
};

export type SupplyShippingPolicy = {
  /** The verified CJ quote covers delivery to the Japanese recipient, so there is no separate domestic leg. */
  domesticShipping: 0 | null;
  /** Keep the domestic-shipping requirement for every non-verified direct-to-Japan CJ route. */
  requireDomesticShipping: boolean;
  directToJapanShippingConfirmed: boolean;
};

function positiveFiniteAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * CJ's CN-to-JP freight quote is the customer's delivery charge, not a
 * separate cross-dock fee. Treat domestic shipping as zero only when the
 * concrete supplier listing says Japan, the quote is positive, and both the
 * supplier and shipping checks are verified. All other routes must still
 * supply an independently known domestic shipping value.
 */
export function resolveSupplyShippingPolicy(input: SupplyShippingEvidence): SupplyShippingPolicy {
  const supplier = typeof input.supplier === "string"
    ? input.supplier.trim().toLowerCase().replace(/[\s_-]+/g, "")
    : "";
  const isCJ = supplier === "cj" || supplier === "cjdropshipping";
  const shipTo = typeof input.shipTo === "string" ? input.shipTo.trim().toUpperCase() : "";
  const hasQuotedFreight = positiveFiniteAmount(input.shippingCost) !== null;
  const supplierVerified = String(input.verificationStatus ?? "").trim().toLowerCase() === "verified";
  const shippingVerified = String(input.shippingStatus ?? "").trim().toLowerCase() === "verified";
  const directToJapanShippingConfirmed = isCJ
    && shipTo === "JP"
    && hasQuotedFreight
    && supplierVerified
    && shippingVerified;

  return {
    domesticShipping: directToJapanShippingConfirmed ? 0 : null,
    requireDomesticShipping: !directToJapanShippingConfirmed,
    directToJapanShippingConfirmed,
  };
}
