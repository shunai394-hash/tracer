export type IdentifierScheme = "asin" | "jan" | "gtin" | "ean" | "upc" | "mpn";

export type ProductIdentifiers = {
  asin: string | null;
  jan: string | null;
  gtin: string | null;
  ean: string | null;
  upc: string | null;
  mpn: string | null;
};

export const EMPTY_IDENTIFIERS: ProductIdentifiers = {
  asin: null,
  jan: null,
  gtin: null,
  ean: null,
  upc: null,
  mpn: null,
};

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Candidate forms for exact marketplace barcode lookup. Never strip a meaningful GTIN-14 indicator digit. */
export function marketplaceBarcodeCandidates(value: string): string[] {
  const normalized = digits(value.trim());
  if (!normalized) return [];
  const candidates = new Set<string>([normalized]);
  if (normalized.length === 12 || normalized.length === 13) candidates.add(normalized.padStart(14, "0"));
  if (normalized.length === 14 && normalized.startsWith("0")) candidates.add(normalized.slice(1));
  return [...candidates];
}

function hasValidGs1CheckDigit(value: string): boolean {
  if (!/^\d{8,14}$/.test(value)) return false;
  const body = value.slice(0, -1);
  const check = Number(value[value.length - 1]);
  let sum = 0;
  for (let i = body.length - 1, position = 0; i >= 0; i -= 1, position += 1) {
    const digit = Number(body[i]);
    sum += digit * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === check;
}

export function normalizeIdentifier(
  scheme: IdentifierScheme,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (scheme === "asin") {
    const asin = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
  }

  if (scheme === "mpn") {
    const mpn = trimmed.replace(/\s+/g, "").toUpperCase();
    if (/^\d{8,14}$/.test(mpn)) return null;
    return mpn.length >= 3 ? mpn : null;
  }

  const num = digits(trimmed);
  if (scheme === "jan" && (num.length === 8 || num.length === 13)) return hasValidGs1CheckDigit(num) ? num : null;
  if (scheme === "ean" && (num.length === 8 || num.length === 13)) return hasValidGs1CheckDigit(num) ? num : null;
  if (scheme === "upc" && num.length === 12) return hasValidGs1CheckDigit(num) ? num : null;
  if (scheme === "gtin" && num.length >= 8 && num.length <= 14) return num;
  return null;
}

export function extractAsinFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  return normalizeIdentifier("asin", match?.[1] ?? null);
}
