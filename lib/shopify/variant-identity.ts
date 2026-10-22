export type ShopifyVariantIdentity = {
  id: string;
  sku: string | null;
};

export type ShopifyVariantResolution =
  | { ok: true; variant: ShopifyVariantIdentity; matchedBy: "saved_id" | "exact_sku" | "single_variant" }
  | { ok: false; reason: "expected_sku_missing" | "saved_variant_id_not_found" | "saved_variant_sku_missing" | "saved_variant_sku_mismatch" | "variant_sku_ambiguous" | "variant_identity_ambiguous" };

export function resolveShopifyVariantIdentity(
  variants: ShopifyVariantIdentity[],
  expectedSku: string,
  savedVariantId?: string | null,
): ShopifyVariantResolution {
  const targetSku = expectedSku.trim();
  const preferredId = String(savedVariantId ?? "").trim();

  if (!targetSku) return { ok: false, reason: "expected_sku_missing" };

  if (preferredId) {
    const saved = variants.find((variant) => variant.id === preferredId);
    if (!saved) return { ok: false, reason: "saved_variant_id_not_found" };
    // The saved Shopify variant ID is already an exact identity within the fetched
    // product. If its SKU is blank, the caller can safely repair that SKU on this
    // same variant; do not block recovery merely because the repair target is blank.
    if (!saved.sku?.trim()) return { ok: true, variant: saved, matchedBy: "saved_id" };
    if (saved.sku.trim() !== targetSku) {
      return { ok: false, reason: "saved_variant_sku_mismatch" };
    }
    return { ok: true, variant: saved, matchedBy: "saved_id" };
  }

  const skuMatches = variants.filter((variant) => String(variant.sku ?? "").trim() === targetSku);
  if (skuMatches.length === 1) return { ok: true, variant: skuMatches[0], matchedBy: "exact_sku" };
  if (skuMatches.length > 1) return { ok: false, reason: "variant_sku_ambiguous" };

  if (variants.length === 1 && variants[0]?.id) {
    return { ok: true, variant: variants[0], matchedBy: "single_variant" };
  }

  return { ok: false, reason: "variant_identity_ambiguous" };
}
