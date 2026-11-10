export type CJVariantImageIdentity = {
  vid?: string | null;
  variantImage?: string | null;
};

/**
 * Use a parent-catalog image only when the catalog row is for the exact same CJ VID.
 * The exact-VID response remains authoritative when it includes an image.
 */
export function resolveCJVariantImageUrl(
  exactVariant: CJVariantImageIdentity | null | undefined,
  catalogVariant: CJVariantImageIdentity | null | undefined,
  parentImageUrl?: string | null,
): string | null {
  const exactVid = String(exactVariant?.vid ?? "").trim();
  const catalogVid = String(catalogVariant?.vid ?? "").trim();
  if (!exactVid || exactVid !== catalogVid) return null;

  const exactImage = typeof exactVariant?.variantImage === "string" ? exactVariant.variantImage.trim() : "";
  const parentImage = typeof parentImageUrl === "string" ? parentImageUrl.trim() : "";
  if (/^https?:\/\//i.test(exactImage) && exactImage !== parentImage) return exactImage;

  const catalogImage = typeof catalogVariant?.variantImage === "string" ? catalogVariant.variantImage.trim() : "";
  return /^https?:\/\//i.test(catalogImage) && catalogImage !== parentImage ? catalogImage : null;
}
