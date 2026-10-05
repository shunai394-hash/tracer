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
  if (scheme === "jan" && (num.length === 8 || num.length === 13)) {
    return hasValidGs1CheckDigit(num) ? num : null;
  }
  if (scheme === "ean" && (num.length === 8 || num.length === 13)) {
    return hasValidGs1CheckDigit(num) ? num : null;
  }
  if (scheme === "upc" && num.length === 12) {
    return hasValidGs1CheckDigit(num) ? num : null;
  }
  if (scheme === "gtin" && num.length >= 8 && num.length <= 14) {
    // Marketplace JAN/EAN/UPC values remain strict above. Supplier catalogs,
    // especially CJ, sometimes expose a numeric barcode without a trustworthy
    // GS1 check digit. Keeping the exact digits still gives us deterministic
    // evidence when they exactly match a validated marketplace barcode.
    // Never infer or repair the digits here; exact equality remains required.
    return num;
  }
  return null;
}

export function extractAsinFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  return normalizeIdentifier("asin", match?.[1] ?? null);
}

export function identifiersFromRecord(record: Record<string, unknown>): ProductIdentifiers {
  return {
    asin:
      normalizeIdentifier("asin", String(record.asin ?? record.ASIN ?? "")) ??
      extractAsinFromUrl(
        typeof record.product_url === "string"
          ? record.product_url
          : typeof record.url === "string"
            ? record.url
            : null,
      ),
    jan: normalizeIdentifier("jan", String(record.jan ?? record.JAN ?? "")),
    gtin: normalizeIdentifier("gtin", String(record.gtin ?? record.GTIN ?? "")),
    ean: normalizeIdentifier("ean", String(record.ean ?? record.EAN ?? "")),
    upc: normalizeIdentifier("upc", String(record.upc ?? record.UPC ?? "")),
    mpn: normalizeIdentifier(
      "mpn",
      String(record.mpn ?? record.model ?? record.model_number ?? ""),
    ),
  };
}

export function hasAnyIdentifier(ids: ProductIdentifiers): boolean {
  return Boolean(ids.asin || ids.jan || ids.gtin || ids.ean || ids.upc || ids.mpn);
}

export function pickIdentifierQuery(ids: ProductIdentifiers): string | null {
  return ids.jan ?? ids.gtin ?? ids.ean ?? ids.upc ?? ids.asin ?? ids.mpn ?? null;
}

export type IdentityMatchMethod =
  | "asin"
  | "jan"
  | "gtin"
  | "ean"
  | "upc"
  | "mpn"
  | "brand_mpn"
  | "specs"
  | "image_url"
  | "title"
  | "none";

export type IdentityMatchResult = {
  linked: boolean;
  salesEligible: boolean;
  method: IdentityMatchMethod;
  confidence: number;
  rationale: string;
};

function eq(a: string | null, b: string | null): boolean {
  return Boolean(a && b && a === b);
}

function toGtin14(value: string): string {
  return value.padStart(14, "0");
}

function barcodeFamilyValue(ids: ProductIdentifiers): string | null {
  const raw = ids.jan ?? ids.gtin ?? ids.ean ?? ids.upc ?? null;
  return raw ? toGtin14(raw) : null;
}

export function matchProductIdentity(args: {
  market: ProductIdentifiers & { brand?: string | null; title?: string | null; imageUrl?: string | null };
  supply: ProductIdentifiers & { brand?: string | null; title?: string | null; imageUrl?: string | null };
}): IdentityMatchResult {
  const market = args.market;
  const supply = args.supply;

  if (eq(market.asin, supply.asin)) {
    return { linked: true, salesEligible: true, method: "asin", confidence: 0.99, rationale: "ASIN matches" };
  }

  for (const scheme of ["jan", "gtin", "ean", "upc"] as const) {
    if (eq(market[scheme], supply[scheme])) {
      return {
        linked: true,
        salesEligible: true,
        method: scheme,
        confidence: 0.98,
        rationale: `${scheme.toUpperCase()} matches`,
      };
    }
  }

  const marketBarcode = barcodeFamilyValue(market);
  const supplyBarcode = barcodeFamilyValue(supply);
  if (marketBarcode && supplyBarcode && marketBarcode === supplyBarcode) {
    return {
      linked: true,
      salesEligible: true,
      method: "gtin",
      confidence: 0.98,
      rationale: "barcode matches across the JAN/EAN/UPC/GTIN family (GTIN-14 normalized)",
    };
  }

  if (eq(market.mpn, supply.mpn)) {
    const brandMarket = (market.brand ?? "").trim().toLowerCase();
    const brandSupply = (supply.brand ?? "").trim().toLowerCase();
    if (brandMarket && brandSupply && brandMarket === brandSupply) {
      return { linked: true, salesEligible: true, method: "brand_mpn", confidence: 0.92, rationale: "brand and model match" };
    }
    return {
      linked: false,
      salesEligible: false,
      method: "mpn",
      confidence: 0.55,
      rationale: !brandMarket || !brandSupply
        ? "MPN matches but brand evidence is incomplete"
        : "MPN matches but brand evidence conflicts",
    };
  }

  if (market.imageUrl && supply.imageUrl && market.imageUrl === supply.imageUrl) {
    return { linked: false, salesEligible: false, method: "image_url", confidence: 0.4, rationale: "image URL matches but identity is not confirmed by identifier" };
  }

  const marketTitle = (market.title ?? "").trim().toLowerCase();
  const supplyTitle = (supply.title ?? "").trim().toLowerCase();
  if (marketTitle && supplyTitle && marketTitle === supplyTitle) {
    return { linked: false, salesEligible: false, method: "title", confidence: 0.2, rationale: "title-only match is not an identity confirmation" };
  }

  return { linked: false, salesEligible: false, method: "none", confidence: 0, rationale: "no identifier overlap" };
}

export function verifyIdentifierMatchInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const cases = [
    (() => {
      const r = matchProductIdentity({ market: { ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN", title: "A" }, supply: { ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN", title: "Different" } });
      return { name: "asin_match_is_sales_eligible", expected: true, actual: r.salesEligible && r.method === "asin" };
    })(),
    (() => {
      const r = matchProductIdentity({ market: { ...EMPTY_IDENTIFIERS, title: "Wireless Earbuds" }, supply: { ...EMPTY_IDENTIFIERS, title: "Wireless Earbuds" } });
      return { name: "title_only_is_not_sales_eligible", expected: true, actual: !r.salesEligible && r.method === "title" };
    })(),
    (() => {
      const r = matchProductIdentity({ market: { ...EMPTY_IDENTIFIERS, jan: "4573138107287" }, supply: { ...EMPTY_IDENTIFIERS, gtin: "4573138107287" } });
      return { name: "jan_and_supplier_gtin_match", expected: true, actual: r.salesEligible && r.method === "gtin" };
    })(),
    (() => {
      const r = matchProductIdentity({ market: { ...EMPTY_IDENTIFIERS, upc: "012345678905" }, supply: { ...EMPTY_IDENTIFIERS, gtin: "00012345678905" } });
      return { name: "upc_and_gtin_match_via_gtin14", expected: true, actual: r.salesEligible && r.method === "gtin" };
    })(),
    (() => {
      const r = matchProductIdentity({ market: { ...EMPTY_IDENTIFIERS, jan: "4573138107287" }, supply: { ...EMPTY_IDENTIFIERS, gtin: "1111111111111" } });
      return { name: "different_barcode_digits_do_not_match", expected: true, actual: !r.salesEligible && r.method === "none" };
    })(),
    { name: "barcode_shaped_numeric_mpn_is_rejected", expected: true, actual: normalizeIdentifier("mpn", "4901301446190") === null },
    (() => {
      const r = matchProductIdentity({ market: { ...EMPTY_IDENTIFIERS, mpn: "ABC-123", title: "A" }, supply: { ...EMPTY_IDENTIFIERS, mpn: "ABC-123", title: "A" } });
      return { name: "mpn_without_brand_is_not_sales_eligible", expected: true, actual: !r.salesEligible && !r.linked };
    })(),
    { name: "pick_identifier_prefers_jan_over_asin", expected: true, actual: pickIdentifierQuery({ ...EMPTY_IDENTIFIERS, jan: "4573138107287", asin: "B0TESTASIN" }) === "4573138107287" },
    { name: "pick_identifier_falls_back_to_asin", expected: true, actual: pickIdentifierQuery({ ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN" }) === "B0TESTASIN" },
    { name: "pick_identifier_falls_back_to_mpn", expected: true, actual: pickIdentifierQuery({ ...EMPTY_IDENTIFIERS, mpn: "ABC-123" }) === "ABC-123" },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
