export type ShopifySkuVariant = { id: string; sku: string | null };

export type ShopifyVariantMatch =
  | { ok: true; variant: ShopifySkuVariant; reason: "unique_sku_match" }
  | { ok: false; variant: null; reason: "target_sku_missing" | "target_sku_duplicate" | "variant_list_incomplete" };

/** Fail closed unless the full variant list contains exactly one exact SKU match. */
export function resolveShopifyVariantBySku(args: {
  variants: ShopifySkuVariant[];
  targetSku: string;
  hasNextPage?: boolean;
}): ShopifyVariantMatch {
  const targetSku = args.targetSku.trim();
  if (args.hasNextPage === true) return { ok: false, variant: null, reason: "variant_list_incomplete" };
  if (!targetSku) return { ok: false, variant: null, reason: "target_sku_missing" };
  const matches = args.variants.filter((variant) => String(variant.sku ?? "").trim() === targetSku);
  if (matches.length === 0) return { ok: false, variant: null, reason: "target_sku_missing" };
  if (matches.length !== 1) return { ok: false, variant: null, reason: "target_sku_duplicate" };
  return { ok: true, variant: matches[0], reason: "unique_sku_match" };
}
