/**
 * Supplier locator normalization and conservative exact-match resolution.
 * These locators preserve candidates when marketplace barcodes are absent;
 * they do not claim marketplace identity from title or image similarity alone.
 */
export type SupplierLocatorInput = {
  supplier?: unknown;
  supplierProductId?: unknown;
  supplierVariantId?: unknown;
  productUrl?: unknown;
  sku?: unknown;
  barcode?: unknown;
  title?: unknown;
  brand?: unknown;
};

export type NormalizedSupplierLocator = {
  supplier: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  productUrl: string | null;
  sku: string | null;
  barcode: string | null;
  title: string | null;
  brand: string | null;
  locatorKey: string | null;
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSupplierUrl(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.forEach((_value, key) => {
      if (/^(utm_.+|gclid|fbclid|ref|source|spm)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    });
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    url.searchParams.sort();
    return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
  } catch {
    return null;
  }
}

export function normalizeSupplierLocator(input: SupplierLocatorInput): NormalizedSupplierLocator {
  const supplier = clean(input.supplier)?.toLowerCase() ?? null;
  const supplierProductId = clean(input.supplierProductId);
  const supplierVariantId = clean(input.supplierVariantId);
  const productUrl = normalizeSupplierUrl(input.productUrl);
  const sku = clean(input.sku)?.toUpperCase() ?? null;
  const barcode = clean(input.barcode)?.replace(/\s+/g, "") ?? null;
  const title = clean(input.title);
  const brand = clean(input.brand);
  // Supplier-native identifiers are namespaced to avoid collisions across suppliers.
  const locatorKey = supplier && supplierProductId
    ? [supplier, supplierProductId, supplierVariantId ?? "_product"].join(":")
    : supplier && productUrl
      ? [supplier, productUrl, supplierVariantId ?? "_product"].join(":")
      : supplier && sku
        ? [supplier, "sku", sku].join(":")
        : null;
  return { supplier, supplierProductId, supplierVariantId, productUrl, sku, barcode, title, brand, locatorKey };
}

export type SupplierLocatorMatch = {
  matched: boolean;
  confidence: "exact" | "strong" | "candidate" | "none";
  method: "supplier_product_and_variant" | "supplier_product" | "supplier_url" | "supplier_sku" | "barcode" | "none";
  reason: string;
};

/**
 * Match supplier offers conservatively. Exact product+variant is strongest;
 * product ID without variant only locates a product family, not a purchasable variant.
 */
export function compareSupplierLocators(
  leftInput: SupplierLocatorInput,
  rightInput: SupplierLocatorInput,
): SupplierLocatorMatch {
  const left = normalizeSupplierLocator(leftInput);
  const right = normalizeSupplierLocator(rightInput);
  if (!left.supplier || left.supplier !== right.supplier) {
    return { matched: false, confidence: "none", method: "none", reason: "supplier_missing_or_mismatch" };
  }
  if (left.supplierProductId && right.supplierProductId && left.supplierProductId === right.supplierProductId) {
    if (left.supplierVariantId && right.supplierVariantId) {
      if (left.supplierVariantId === right.supplierVariantId) {
        return { matched: true, confidence: "exact", method: "supplier_product_and_variant", reason: "exact_supplier_product_and_variant" };
      }
      return { matched: false, confidence: "none", method: "none", reason: "supplier_variant_mismatch" };
    }
    return { matched: true, confidence: "strong", method: "supplier_product", reason: "product_located_variant_unresolved" };
  }
  if (left.productUrl && right.productUrl && left.productUrl === right.productUrl) {
    if (left.supplierVariantId && right.supplierVariantId && left.supplierVariantId !== right.supplierVariantId) {
      return { matched: false, confidence: "none", method: "none", reason: "supplier_variant_mismatch" };
    }
    return { matched: true, confidence: left.supplierVariantId && right.supplierVariantId ? "exact" : "strong", method: "supplier_url", reason: "normalized_supplier_url_match" };
  }
  if (left.sku && right.sku && left.sku === right.sku) {
    return { matched: true, confidence: "candidate", method: "supplier_sku", reason: "sku_match_requires_product_variant_confirmation" };
  }
  if (left.barcode && right.barcode && left.barcode === right.barcode) {
    return { matched: true, confidence: "strong", method: "barcode", reason: "barcode_match_within_supplier" };
  }
  return { matched: false, confidence: "none", method: "none", reason: "no_shared_supplier_locator" };
}
