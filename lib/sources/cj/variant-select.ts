export type CJVerifiedWarehouseInventory = {
  countryCode: string;
  quantity: number;
  storageId: string | null;
};

export type CJProductVariant = {
  vid: string;
  productId: string;
  sku: string | null;
  nameEn: string | null;
  sellPrice: string | null;
  /** CJ's documented numeric variant barcode. */
  barcode: string | null;
  /** Sum of CJ-owned stock in verified warehouses only; factory stock is excluded. */
  inventory: number | null;
  /** Verified warehouse stock used to choose a real shipping origin. */
  inventoryByCountry?: CJVerifiedWarehouseInventory[];
};

export function selectUnambiguousVariant(
  variants: CJProductVariant[],
): CJProductVariant | null {
  return variants.length === 1 ? variants[0] : null;
}

/**
 * When a marketplace barcode exactly identifies one CJ variant, that variant
 * is safe to use even when the CJ product has multiple color/size variants.
 * Multiple matches remain ambiguous and are rejected.
 */
export function selectVariantMatchingBarcode(
  variants: CJProductVariant[],
  barcode: string | null,
): CJProductVariant | null {
  if (!barcode) return null;
  const matches = variants.filter((variant) => variant.barcode === barcode);
  return matches.length === 1 ? matches[0] : null;
}

/** Recover only from a unique barcode match or a single available variant. Price is not identity. */
export function selectRecoverableVariant(variants: CJProductVariant[], barcode: string | null): CJProductVariant | null {
  const matched = selectVariantMatchingBarcode(variants, barcode);
  if (matched?.vid) return matched;
  const single = selectUnambiguousVariant(variants);
  return single?.vid ? single : null;
}

export function verifyVariantSelectionInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const one: CJProductVariant[] = [
    {
      vid: "v1",
      productId: "p1",
      sku: "SKU1",
      nameEn: "Red",
      sellPrice: "9.99",
      barcode: "4901234567890",
      inventory: null,
    },
  ];
  const many: CJProductVariant[] = [
    ...one,
    {
      vid: "v2",
      productId: "p1",
      sku: "SKU2",
      nameEn: "Blue",
      sellPrice: "9.99",
      barcode: "4901234567891",
      inventory: null,
    },
  ];

  const cases = [
    {
      name: "ambiguous_variants_are_not_resolved_by_cheapest_price",
      expected: true,
      actual: selectRecoverableVariant([
        { ...one[0], vid: "cheap", sellPrice: "1.00", barcode: "111" },
        { ...one[0], vid: "dear", sellPrice: "9.00", barcode: "222" },
      ], null) === null,
    },
    {
      name: "exact_barcode_wins_over_cheapest_price",
      expected: true,
      actual: selectRecoverableVariant([
        { ...one[0], vid: "cheap", sellPrice: "1.00", barcode: "111" },
        { ...one[0], vid: "dear", sellPrice: "9.00", barcode: "222" },
      ], "222")?.vid === "dear",
    },
    {
      name: "single_variant_is_selected",
      expected: true,
      actual: selectUnambiguousVariant(one)?.vid === "v1",
    },
    {
      name: "multiple_variants_returns_null_not_a_guess",
      expected: true,
      actual: selectUnambiguousVariant(many) === null,
    },
    {
      name: "barcode_selects_exactly_one_variant",
      expected: true,
      actual: selectVariantMatchingBarcode(many, "4901234567891")?.vid === "v2",
    },
    {
      name: "ambiguous_barcode_returns_null",
      expected: true,
      actual:
        selectVariantMatchingBarcode(
          [
            ...many,
            {
              vid: "v3",
              productId: "p1",
              sku: "SKU3",
              nameEn: "Green",
              sellPrice: "9.99",
              barcode: "4901234567891",
              inventory: null,
            },
          ],
          "4901234567891",
        ) === null,
    },
    {
      name: "zero_variants_returns_null",
      expected: true,
      actual: selectUnambiguousVariant([]) === null,
    },
  ];

  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
