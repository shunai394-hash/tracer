/**
 * Pure planning helpers for safe parent/variant storefront grouping.
 *
 * These helpers do not publish, merge, or mutate listings. BASE variations share
 * one item-level price, so only variants with the same positive integer selling
 * price can be represented as one BASE item.
 */
export type ParentVariantInput = {
  variantId: string;
  sourceKey: string;
  sourceVariantKey: string;
  title: string;
  sellingPrice: number;
  stock: number;
  sku: string;
  externalProductId?: string | null;
  externalVariantId?: string | null;
};

export type BaseVariantGroupPlan =
  | {
      sourceKey: string;
      kind: "groupable";
      sellingPrice: number;
      variants: Array<ParentVariantInput & { variationName: string }>;
    }
  | {
      sourceKey: string;
      kind: "keep_separate";
      reason: "invalid_input" | "invalid_price" | "mixed_prices" | "ambiguous_variant_identity";
      variants: ParentVariantInput[];
    };

function normalized(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim();
}

/**
 * Plan grouping per canonical parent. This intentionally never decides which
 * existing external product should be retained and never authorizes deletion.
 */
export function planBaseVariantGroups(
  input: ParentVariantInput[],
): BaseVariantGroupPlan[] {
  const byParent = new Map<string, ParentVariantInput[]>();
  for (const raw of input) {
    const sourceKey = normalized(raw.sourceKey);
    const variantId = normalized(raw.variantId);
    const sourceVariantKey = normalized(raw.sourceVariantKey);
    const sku = normalized(raw.sku);
    const title = normalized(raw.title);
    const price = Number(raw.sellingPrice);
    const stock = Number(raw.stock);
    if (!sourceKey || !variantId || !sourceVariantKey || !sku || !title ||
        !Number.isSafeInteger(price) || price <= 0 ||
        !Number.isSafeInteger(stock) || stock < 0) {
      const key = sourceKey || "unknown-parent";
      const rows = byParent.get(key) ?? [];
      rows.push({ ...raw, sourceKey: key });
      byParent.set(key, rows);
      continue;
    }
    const rows = byParent.get(sourceKey) ?? [];
    rows.push({ ...raw, sourceKey, variantId, sourceVariantKey, sku, title, sellingPrice: price, stock });
    byParent.set(sourceKey, rows);
  }

  return [...byParent.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sourceKey, variants]) => {
    const identities = variants.map((variant) => [
      normalized(variant.variantId),
      normalized(variant.sourceVariantKey),
      normalized(variant.sku),
    ]);
    const identityKeys = identities.map((identity) => JSON.stringify(identity));
    const hasAmbiguousIdentity = identityKeys.some((key, index) => identityKeys.indexOf(key) !== index) ||
      identities.some(([variantId, sourceVariantKey, sku]) => !variantId || !sourceVariantKey || !sku) ||
      identities.some((identity, index) => identities.some((other, otherIndex) =>
        otherIndex !== index && identity[0] === other[0])) ||
      identities.some((identity, index) => identities.some((other, otherIndex) =>
        otherIndex !== index && identity[1] === other[1])) ||
      identities.some((identity, index) => identities.some((other, otherIndex) =>
        otherIndex !== index && identity[2] === other[2]));
    const hasInvalidInput = variants.some((variant) =>
      !normalized(variant.sourceKey) || !normalized(variant.variantId) ||
      !normalized(variant.sourceVariantKey) || !normalized(variant.sku) ||
      !normalized(variant.title) || !Number.isSafeInteger(Number(variant.stock)) ||
      Number(variant.stock) < 0);
    const hasInvalidPrice = variants.some((variant) =>
      !Number.isSafeInteger(Number(variant.sellingPrice)) || Number(variant.sellingPrice) <= 0);
    const prices = new Set(variants.map((variant) => Number(variant.sellingPrice)));
    const reason = hasAmbiguousIdentity
      ? "ambiguous_variant_identity" as const
      : hasInvalidInput
        ? "invalid_input" as const
        : hasInvalidPrice
          ? "invalid_price" as const
          : prices.size > 1
            ? "mixed_prices" as const
            : null;

    if (reason) return { sourceKey, kind: "keep_separate" as const, reason, variants };
    return {
      sourceKey,
      kind: "groupable" as const,
      sellingPrice: Number(variants[0].sellingPrice),
      variants: variants.map((variant) => ({
        ...variant,
        variationName: normalized(variant.title) || normalized(variant.sourceVariantKey),
      })),
    };
  });
}
