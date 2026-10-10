import type { ProductIdentifiers } from "./identifiers";

/**
 * Variant-level sale identity requires a matching valid barcode on both records.
 * Product-level ASIN/MPN may help retrieve a candidate, but cannot identify a
 * concrete size, color, pack, or supplier variant.
 */
export function exactVariantBarcodeMethod(
  market: ProductIdentifiers,
  variant: ProductIdentifiers,
): "jan" | "gtin" | "ean" | "upc" | null {
  const schemes = ["jan", "gtin", "ean", "upc"] as const;
  for (const marketScheme of schemes) {
    const marketValue = market[marketScheme];
    if (!marketValue) continue;
    for (const variantScheme of schemes) {
      const variantValue = variant[variantScheme];
      if (!variantValue) continue;
      if (marketValue.padStart(14, "0") === variantValue.padStart(14, "0")) {
        return marketScheme === variantScheme ? marketScheme : "gtin";
      }
    }
  }
  return null;
}
