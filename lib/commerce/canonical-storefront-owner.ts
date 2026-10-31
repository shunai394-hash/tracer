/** Exact supplier product and variant IDs. Titles are never part of this key. */
export function supplierIdentityKey(productId: unknown, variantId: unknown): string | null {
  const product = String(productId ?? "").trim();
  const variant = String(variantId ?? "").trim();
  if (!product || !variant) return null;
  return product + "\n" + variant;
}

export function externalIdTail(value: unknown): string {
  return String(value ?? "").trim().split("/").pop()?.trim() ?? "";
}

/**
 * A legacy shop listing is not a second product when its supplier variant is
 * already the commerce catalog. The commerce channel item stays on sale.
 */
export type LegacyChannelDecision = "same_item" | "hide_duplicate" | "adopt" | "suppress_new_item";

export function classifyLegacyChannelItem(input: {
  legacyExternalId: unknown;
  canonicalExternalId: unknown;
}): LegacyChannelDecision {
  const legacy = externalIdTail(input.legacyExternalId);
  const canonical = externalIdTail(input.canonicalExternalId);
  if (canonical && legacy === canonical) return "same_item";
  if (canonical && legacy && legacy !== canonical) return "hide_duplicate";
  if (!canonical && legacy) return "adopt";
  return "suppress_new_item";
}
