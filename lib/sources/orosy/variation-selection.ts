export type OrosyVariationAvailability = {
  variationId: string;
  stockLevel: string | null;
  stockQty: number | null;
};

/** Selects only an identity-matched variant or a product with one variation. */
export function selectOrosyVariation<T extends OrosyVariationAvailability>(
  variations: readonly T[],
  identityMatchedVariationIds: readonly string[] = [],
): T | null {
  if (identityMatchedVariationIds.length > 0) {
    const matchedIds = new Set(identityMatchedVariationIds);
    const matches = variations.filter((variation) => matchedIds.has(variation.variationId));
    return matches.length === 1 ? matches[0] : null;
  }

  if (variations.length === 1) return variations[0];
  return null;
}

export function verifyOrosyVariationSelectionInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const variations: OrosyVariationAvailability[] = [
    { variationId: "oos-first", stockLevel: "out_of_stock", stockQty: 0 },
    { variationId: "stocked-second", stockLevel: "in_stock", stockQty: 5 },
    { variationId: "oos-third", stockLevel: "out_of_stock", stockQty: 0 },
  ];
  const noIdentity = selectOrosyVariation(variations);
  const oneIdentityMatch = selectOrosyVariation(variations, ["oos-first"]);
  const ambiguousIdentity = selectOrosyVariation(variations, ["oos-first", "stocked-second"]);
  const oneOutOfStock = selectOrosyVariation([variations[0]]);
  const unknownStock = selectOrosyVariation([
    { variationId: "unknown-a", stockLevel: null, stockQty: null },
    { variationId: "unknown-b", stockLevel: null, stockQty: null },
  ]);

  const cases = [
    {
      name: "in_stock_status_alone_does_not_guess_market_variant",
      expected: true,
      actual: noIdentity === null,
    },
    {
      name: "unique_identity_matched_variant_is_selected_even_when_out_of_stock",
      expected: true,
      actual: oneIdentityMatch?.variationId === "oos-first",
    },
    {
      name: "multiple_identity_matched_variants_are_not_guessed",
      expected: true,
      actual: ambiguousIdentity === null,
    },
    {
      name: "single_out_of_stock_variant_remains_identified_but_not_available",
      expected: true,
      actual:
        oneOutOfStock?.variationId === "oos-first" &&
        oneOutOfStock.stockQty === 0,
    },
    {
      name: "unknown_stock_is_not_treated_as_available",
      expected: true,
      actual: unknownStock === null,
    },
  ];

  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
