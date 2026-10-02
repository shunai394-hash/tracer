// Demand match evidence model. Pure functions only (no server imports) so the
// precision rules can be exercised directly.
//
// A demand_product_matches row says "this demand observation is demand for
// this exact product". Only identifier-grade evidence proves that. Text
// similarity, search provenance ("CJ returned this item when we searched the
// demand query") and title relevance are recorded for traceability but can
// never make demand sufficient for TEST_READY.

export const STRONG_MATCH_METHODS = [
  "exact_jan",
  "exact_gtin",
  "exact_model",
  "exact_brand_model",
  "verified_source_mapping",
] as const;

export const WEAK_MATCH_METHODS = [
  "normalized_title",
  "weak_text_similarity",
  "search_provenance",
] as const;

export type DemandMatchMethod =
  | (typeof STRONG_MATCH_METHODS)[number]
  | (typeof WEAK_MATCH_METHODS)[number];

export type DemandMatchEvidence = {
  method: DemandMatchMethod;
  /** Human-readable reason this observation was linked to this product. */
  rationale: string;
  /** Raw facts compared (identifier values, normalized strings, source ids). */
  facts: Record<string, unknown>;
  sourceId: string | null;
};

const STRONG = new Set<string>(STRONG_MATCH_METHODS);

// Legacy schema (20260920170000) only allows these match_method values. Until
// the evidence migration is applied, the true method travels in the
// rationale as a tagged JSON envelope and the column holds a legacy value.
export const LEGACY_MATCH_METHODS = new Set(["keyword", "category", "brand", "semantic", "manual"]);
const EVIDENCE_TAG = "tracer-evidence:";

export function encodeLegacyRationale(evidence: DemandMatchEvidence): string {
  return `${EVIDENCE_TAG}${JSON.stringify({ method: evidence.method, rationale: evidence.rationale, facts: evidence.facts, sourceId: evidence.sourceId })}`;
}

export function legacyMethodFor(method: DemandMatchMethod): string {
  // Never map weak evidence to a value that reads as strong.
  return STRONG.has(method) ? "manual" : method === "search_provenance" ? "semantic" : "keyword";
}

/**
 * The effective method of a stored match. Rows written before this evidence
 * model existed carry legacy methods ("keyword", ...) with no proof, so they
 * resolve to weak_text_similarity.
 */
export function resolveMatchMethod(row: { match_method?: unknown; rationale?: unknown }): DemandMatchMethod {
  const rationale = typeof row.rationale === "string" ? row.rationale : "";
  if (rationale.startsWith(EVIDENCE_TAG)) {
    try {
      const parsed = JSON.parse(rationale.slice(EVIDENCE_TAG.length)) as { method?: unknown };
      const method = String(parsed.method ?? "");
      if (STRONG.has(method) || (WEAK_MATCH_METHODS as readonly string[]).includes(method)) {
        return method as DemandMatchMethod;
      }
    } catch {
      // fall through to the column value
    }
  }
  const column = String(row.match_method ?? "");
  if (STRONG.has(column) || (WEAK_MATCH_METHODS as readonly string[]).includes(column)) {
    return column as DemandMatchMethod;
  }
  return "weak_text_similarity";
}

export function isStrongDemandMatch(row: { match_method?: unknown; rationale?: unknown }): boolean {
  return STRONG.has(resolveMatchMethod(row));
}

// ---------------------------------------------------------------------------
// Identifier normalization. Only formatting differences are normalized;
// values that differ in content never become equal.

/** JAN/EAN-13, UPC-A (12), GTIN-14, EAN-8 as a canonical GTIN-14 string. */
export function canonicalGtin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).normalize("NFKC").replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  if (!hasValidGtinCheckDigit(digits)) return null;
  return digits.padStart(14, "0");
}

function hasValidGtinCheckDigit(digits: string): boolean {
  const body = digits.slice(0, -1);
  const check = Number(digits.slice(-1));
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Model / manufacturer part number: NFKC (full-width -> half-width), upper
 * case, and removal of spaces, hyphens, dots and slashes, which are pure
 * formatting in part numbers ("WH-1000XM5" == "WH1000XM5"). Too-short or
 * purely numeric strings are rejected because they are not distinctive.
 */
export function canonicalModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").toUpperCase().replace(/[\s\-_./]/g, "");
  if (normalized.length < 4) return null;
  if (!/[A-Z]/.test(normalized) || !/\d/.test(normalized)) return null;
  return normalized;
}

export function canonicalBrand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[\s\-_.・'’]/g, "");
  return normalized.length >= 2 ? normalized : null;
}

// ---------------------------------------------------------------------------
// Variant compatibility. Two titles that disagree on generation, tier, size,
// capacity, pack count or colour are different products even when every other
// token matches ("iPhone 15 case" vs "iPhone 15 Pro case").

const TIER_TOKENS = ["pro", "max", "plus", "mini", "ultra", "lite", "air", "se", "fe"];

export function variantSignature(title: string): {
  tiers: string[];
  numbers: string[];
  quantities: string[];
  models: string[];
} {
  const normalized = title.normalize("NFKC").toLowerCase();
  const tokens = normalized.split(/[^\p{L}\p{N}.]+/u).filter(Boolean);
  const tiers = TIER_TOKENS.filter((tier) => tokens.includes(tier));
  const quantities = Array.from(
    normalized.matchAll(/(\d+(?:\.\d+)?)\s*(gb|tb|mb|ml|l|g|kg|mm|cm|m|inch|インチ|個|枚|本|袋|pcs|pack|個入|w|mah|v)\b/giu),
  ).map((match) => `${match[1]}${match[2].toLowerCase()}`);
  const numbers = tokens.filter((token) => /^\d{1,4}$/.test(token));
  // Alphanumeric generation/model tokens ("s24", "m2", "xm5"), excluding
  // quantities already captured above ("10000mah", "1tb").
  const quantityTokens = new Set(quantities);
  const models = tokens.filter((token) =>
    /\p{L}/u.test(token) && /\d/.test(token) && !quantityTokens.has(token) &&
    !/^\d+(?:\.\d+)?(gb|tb|mb|ml|l|g|kg|mm|cm|m|inch|インチ|個|枚|本|袋|pcs|pack|個入|w|mah|v)$/u.test(token),
  );
  return { tiers: tiers.sort(), numbers: numbers.sort(), quantities: quantities.sort(), models: models.sort() };
}

/**
 * True when both titles carry the same variant markers. A side that carries a
 * marker the other side lacks is a conflict: "iPhone 15" vs "iPhone 15 Pro"
 * differ in tier, "iPhone 15" vs "iPhone 14" in generation.
 */
export function variantsCompatible(a: string, b: string): { compatible: boolean; conflicts: string[] } {
  const left = variantSignature(a);
  const right = variantSignature(b);
  const conflicts: string[] = [];
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((value, i) => value === y[i]);
  if (!same(left.tiers, right.tiers)) conflicts.push(`tier:${left.tiers.join("+") || "-"}≠${right.tiers.join("+") || "-"}`);
  if (!same(left.numbers, right.numbers)) conflicts.push(`number:${left.numbers.join("+") || "-"}≠${right.numbers.join("+") || "-"}`);
  if (!same(left.models, right.models)) conflicts.push(`model:${left.models.join("+") || "-"}≠${right.models.join("+") || "-"}`);
  if (!same(left.quantities, right.quantities)) conflicts.push(`quantity:${left.quantities.join("+") || "-"}≠${right.quantities.join("+") || "-"}`);
  return { compatible: conflicts.length === 0, conflicts };
}

// ---------------------------------------------------------------------------
// Exact identity resolution for one demand observation against the market
// product identifier index. Order: GTIN/JAN -> brand+model -> model. A key
// that maps to several products is ambiguous and never matches; a model-only
// hit whose product carries a different brand is rejected.

export type IdentifierIndex = {
  productsByGtin: Map<string, Set<string>>;
  productsByBrandModel: Map<string, Set<string>>;
  productsByModel: Map<string, Set<string>>;
  brandsByProduct: Map<string, Set<string>>;
};

export type ObservationIdentifiers = {
  gtin: string | null;
  /** True when the GTIN came from a JAN field. */
  gtinIsJan: boolean;
  model: string | null;
  brand: string | null;
};

export type ExactIdentityDecision =
  | { status: "exact"; productId: string; method: DemandMatchMethod; facts: Record<string, unknown> }
  | { status: "ambiguous"; key: string; candidates: string[] }
  | { status: "brand_conflict"; productId: string; observationBrand: string; productBrands: string[] }
  | { status: "none" };

export function readObservationIdentifiers(metadata: Record<string, unknown>): ObservationIdentifiers {
  const janGtin = canonicalGtin(metadata.jan);
  const gtin = janGtin ?? [metadata.gtin, metadata.ean, metadata.upc]
    .map(canonicalGtin)
    .find((value): value is string => Boolean(value)) ?? null;
  return {
    gtin,
    gtinIsJan: Boolean(janGtin),
    model: canonicalModel(metadata.model) ?? canonicalModel(metadata.mpn),
    brand: canonicalBrand(metadata.brand),
  };
}

export function resolveExactIdentity(ids: ObservationIdentifiers, index: IdentifierIndex): ExactIdentityDecision {
  const gtinProducts = ids.gtin ? index.productsByGtin.get(ids.gtin) : undefined;
  if (ids.gtin && gtinProducts) {
    if (gtinProducts.size > 1) return { status: "ambiguous", key: `gtin:${ids.gtin}`, candidates: [...gtinProducts] };
    return { status: "exact", productId: [...gtinProducts][0], method: ids.gtinIsJan ? "exact_jan" : "exact_gtin", facts: { gtin14: ids.gtin } };
  }
  const brandModelKey = ids.brand && ids.model ? `${ids.brand}|${ids.model}` : null;
  const brandModelProducts = brandModelKey ? index.productsByBrandModel.get(brandModelKey) : undefined;
  if (brandModelKey && brandModelProducts) {
    if (brandModelProducts.size > 1) return { status: "ambiguous", key: `brand_model:${brandModelKey}`, candidates: [...brandModelProducts] };
    return { status: "exact", productId: [...brandModelProducts][0], method: "exact_brand_model", facts: { brand: ids.brand, model: ids.model } };
  }
  const modelProducts = ids.model ? index.productsByModel.get(ids.model) : undefined;
  if (ids.model && modelProducts) {
    if (modelProducts.size > 1) return { status: "ambiguous", key: `model:${ids.model}`, candidates: [...modelProducts] };
    const productId = [...modelProducts][0];
    const productBrands = index.brandsByProduct.get(productId);
    if (ids.brand && productBrands && productBrands.size > 0 && !productBrands.has(ids.brand)) {
      return { status: "brand_conflict", productId, observationBrand: ids.brand, productBrands: [...productBrands] };
    }
    return { status: "exact", productId, method: "exact_model", facts: { model: ids.model, brand: ids.brand } };
  }
  return { status: "none" };
}

export function buildIdentifierIndex(
  bestsellers: Array<{ product_id: unknown; jan?: unknown; gtin?: unknown; ean?: unknown; upc?: unknown; mpn?: unknown; model?: unknown; brand?: unknown }>,
  identifiers: Array<{ product_id: unknown; scheme: unknown; value: unknown }>,
): IdentifierIndex {
  const index: IdentifierIndex = {
    productsByGtin: new Map(),
    productsByBrandModel: new Map(),
    productsByModel: new Map(),
    brandsByProduct: new Map(),
  };
  const add = (map: Map<string, Set<string>>, key: string | null, value: string) => {
    if (!key) return;
    const set = map.get(key) ?? new Set<string>();
    set.add(value);
    map.set(key, set);
  };
  for (const row of bestsellers) {
    if (!row.product_id) continue;
    const productId = String(row.product_id);
    for (const value of [row.jan, row.gtin, row.ean, row.upc]) add(index.productsByGtin, canonicalGtin(value), productId);
    const brand = canonicalBrand(row.brand);
    if (brand) add(index.brandsByProduct, productId, brand);
    for (const model of new Set([canonicalModel(row.mpn), canonicalModel(row.model)])) {
      add(index.productsByModel, model, productId);
      if (model && brand) add(index.productsByBrandModel, `${brand}|${model}`, productId);
    }
  }
  for (const row of identifiers) {
    if (!row.product_id) continue;
    const scheme = String(row.scheme ?? "").toLowerCase();
    if (["jan", "gtin", "ean", "upc"].includes(scheme)) add(index.productsByGtin, canonicalGtin(row.value), String(row.product_id));
    if (["mpn", "model"].includes(scheme)) add(index.productsByModel, canonicalModel(row.value), String(row.product_id));
  }
  return index;
}
