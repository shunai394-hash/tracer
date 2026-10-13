/**
 * CJ-native product identity: a separate proof class for CJ-only products
 * that have no marketplace barcode twin. It proves that the exact CJ product
 * and variant TRACER would order exist, are unambiguous, in stock, priced,
 * shippable to Japan, and match the image and variant TRACER would sell.
 *
 * It does not prove sameness with any other marketplace's product, and it is
 * never sufficient on its own to sell: profit, Japanese copy, channel gates and
 * an enabled CJ order path are still required elsewhere.
 *
 * Pure module: no network, database, or path-alias imports.
 */

export const CJ_NATIVE_IDENTITY_METHOD = "cj_native_variant";

/** Evidence older than this no longer counts as a current identity proof. */
export const CJ_NATIVE_IDENTITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CjNativeIdentityObservation = {
  /** What TRACER has stored and would order. */
  stored: {
    supplierProductId: unknown;
    supplierVariantId: unknown;
    /** Product image TRACER would show on the sales page. */
    listingImageUrl: unknown;
    /** Supplier/listing title TRACER stored for this exact variant. */
    listingTitle: unknown;
    /** Rows in supplier_listings carrying this exact CJ product+variant pair. */
    duplicateRowCount: number;
  };
  /** What CJ returned just now; null means the lookup failed or returned nothing. */
  live: {
    variant: { vid: unknown; productId: unknown; nameEn: unknown; sellPrice: unknown } | null;
    /** Every variant id CJ lists for the product; null when the lookup failed. */
    productVariantIds: unknown[] | null;
    productImageUrl: unknown;
    stock: unknown;
    jpFreight: unknown;
  };
  observedAt: string;
};

export type CjNativeIdentityDecision = {
  verified: boolean;
  method: typeof CJ_NATIVE_IDENTITY_METHOD;
  reasons: string[];
  evidence: {
    supplier_product_id: string | null;
    supplier_variant_id: string | null;
    live_variant_id: string | null;
    live_product_id: string | null;
    variant_name: string | null;
    product_variant_count: number | null;
    live_price_usd: number | null;
    live_stock: number | null;
    jp_freight_usd: number | null;
    listing_image_url: string | null;
    cj_product_image_url: string | null;
    observed_at: string;
    result: "verified" | "rejected";
    reasons: string[];
  };
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finite(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Compare image URLs by host and path; CDN query strings are not identity. */
export function normalizeImageUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.hostname.toLowerCase()}${url.pathname}`;
  } catch {
    return null;
  }
}

function normalizeWords(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function evaluateCjNativeIdentity(observation: CjNativeIdentityObservation): CjNativeIdentityDecision {
  const reasons: string[] = [];
  const { stored, live } = observation;
  const storedPid = text(stored.supplierProductId);
  const storedVid = text(stored.supplierVariantId);
  if (!storedPid) reasons.push("supplier_product_id_missing");
  if (!storedVid) reasons.push("supplier_variant_id_missing");
  if (stored.duplicateRowCount !== 1) reasons.push("supplier_identity_ambiguous");

  const liveVid = text(live.variant?.vid);
  const livePid = text(live.variant?.productId);
  if (!live.variant) reasons.push("cj_variant_lookup_failed");
  else {
    if (!liveVid || liveVid !== storedVid) reasons.push("cj_variant_id_mismatch");
    if (!livePid || livePid !== storedPid) reasons.push("cj_product_id_mismatch");
  }

  const variantIds = live.productVariantIds === null ? null : live.productVariantIds.map(text).filter((id): id is string => Boolean(id));
  if (variantIds === null) reasons.push("cj_product_variants_lookup_failed");
  else if (variantIds.filter((id) => id === storedVid).length !== 1) reasons.push("cj_variant_not_unique_in_product");

  const variantName = text(live.variant?.nameEn);
  // A multi-variant product must prove which colour/size TRACER sells.
  if (variantIds !== null && variantIds.length > 1) {
    const title = text(stored.listingTitle);
    if (!variantName || !title || !normalizeWords(title).includes(normalizeWords(variantName))) {
      reasons.push("variant_spec_unconfirmed");
    }
  }

  const price = finite(live.variant?.sellPrice);
  if (price === null || price <= 0) reasons.push("cj_price_unconfirmed");
  const stock = finite(live.stock);
  if (stock === null || stock < 0) reasons.push("cj_stock_unknown");
  else if (stock < 1) reasons.push("cj_stock_zero");
  const freight = finite(live.jpFreight);
  if (freight === null || freight <= 0) reasons.push("jp_shipping_unavailable");

  const listingImage = normalizeImageUrl(stored.listingImageUrl);
  const cjImage = normalizeImageUrl(live.productImageUrl);
  if (!listingImage) reasons.push("listing_image_missing");
  else if (!cjImage) reasons.push("cj_product_image_unavailable");
  else if (listingImage !== cjImage) reasons.push("listing_image_not_cj_product_image");

  const unique = Array.from(new Set(reasons));
  const verified = unique.length === 0;
  return {
    verified,
    method: CJ_NATIVE_IDENTITY_METHOD,
    reasons: unique,
    evidence: {
      supplier_product_id: storedPid,
      supplier_variant_id: storedVid,
      live_variant_id: liveVid,
      live_product_id: livePid,
      variant_name: variantName,
      product_variant_count: variantIds === null ? null : variantIds.length,
      live_price_usd: price,
      live_stock: stock,
      jp_freight_usd: freight,
      listing_image_url: text(stored.listingImageUrl),
      cj_product_image_url: text(live.productImageUrl),
      observed_at: observation.observedAt,
      result: verified ? "verified" : "rejected",
      reasons: unique,
    },
  };
}

/** A CJ-native proof counts only while it is recent; stale proofs fail closed. */
export function isCjNativeIdentityFresh(verifiedAt: unknown, nowMs: number, maxAgeMs = CJ_NATIVE_IDENTITY_MAX_AGE_MS): boolean {
  const at = typeof verifiedAt === "string" ? Date.parse(verifiedAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  return at <= nowMs + 60_000 && nowMs - at <= maxAgeMs;
}
