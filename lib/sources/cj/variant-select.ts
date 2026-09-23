export type CJProductVariant = {
  vid: string;
  productId: string;
  sku: string | null;
  nameEn: string | null;
  sellPrice: string | null;
  /** Not corroborated in any source found; always null until confirmed. */
  inventory: number | null;
};

/**
 * Only returns a variant when there is exactly one candidate — with several
 * variants (size/color) picking one would be a guess, and this codebase
 * treats an unresolved choice as unknown, not as "pick the first one".
 */
export function selectUnambiguousVariant(
  variants: CJProductVariant[],
): CJProductVariant | null {
  return variants.length === 1 ? variants[0] : null;
}

export function verifyVariantSelectionInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const one: CJProductVariant[] = [
    { vid: "v1", productId: "p1", sku: "SKU1", nameEn: "Red", sellPrice: "9.99", inventory: null },
  ];
  const many: CJProductVariant[] = [
    ...one,
    { vid: "v2", productId: "p1", sku: "SKU2", nameEn: "Blue", sellPrice: "9.99", inventory: null },
  ];

  const cases = [
    { name: "single_variant_is_selected", expected: true, actual: selectUnambiguousVariant(one)?.vid === "v1" },
    { name: "multiple_variants_returns_null_not_a_guess", expected: true, actual: selectUnambiguousVariant(many) === null },
    { name: "zero_variants_returns_null", expected: true, actual: selectUnambiguousVariant([]) === null },
  ];

  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
