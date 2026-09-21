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
    return mpn.length >= 3 ? mpn : null;
  }

  const num = digits(trimmed);
  if (scheme === "jan" && (num.length === 8 || num.length === 13)) return num;
  if (scheme === "ean" && (num.length === 8 || num.length === 13)) return num;
  if (scheme === "upc" && num.length === 12) return num;
  if (scheme === "gtin" && num.length >= 8 && num.length <= 14) return num;
  return null;
}

export function extractAsinFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  return normalizeIdentifier("asin", match?.[1] ?? null);
}

export function identifiersFromRecord(
  record: Record<string, unknown>,
): ProductIdentifiers {
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

/**
 * Single, shared priority order for "which identifier do we search a
 * supplier catalog with". Barcodes (JAN/GTIN/EAN/UPC) are preferred over
 * ASIN/MPN because they are the most portable across marketplaces; a
 * missing identifier here means the caller genuinely has nothing to
 * search with and must not fall back to a title search.
 */
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

/**
 * Sales candidates require identifier-grade identity.
 * Title-only matches never become sales eligible.
 */
export function matchProductIdentity(args: {
  market: ProductIdentifiers & { brand?: string | null; title?: string | null; imageUrl?: string | null };
  supply: ProductIdentifiers & { brand?: string | null; title?: string | null; imageUrl?: string | null };
}): IdentityMatchResult {
  const market = args.market;
  const supply = args.supply;

  if (eq(market.asin, supply.asin)) {
    return {
      linked: true,
      salesEligible: true,
      method: "asin",
      confidence: 0.99,
      rationale: "ASIN matches",
    };
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

  if (eq(market.mpn, supply.mpn)) {
    const brandMarket = (market.brand ?? "").trim().toLowerCase();
    const brandSupply = (supply.brand ?? "").trim().toLowerCase();
    if (brandMarket && brandSupply && brandMarket === brandSupply) {
      return {
        linked: true,
        salesEligible: true,
        method: "brand_mpn",
        confidence: 0.92,
        rationale: "brand and model match",
      };
    }
    return {
      linked: true,
      salesEligible: true,
      method: "mpn",
      confidence: 0.88,
      rationale: "model/MPN matches",
    };
  }

  if (market.imageUrl && supply.imageUrl && market.imageUrl === supply.imageUrl) {
    return {
      linked: false,
      salesEligible: false,
      method: "image_url",
      confidence: 0.4,
      rationale: "image URL matches but identity is not confirmed by identifier",
    };
  }

  const marketTitle = (market.title ?? "").trim().toLowerCase();
  const supplyTitle = (supply.title ?? "").trim().toLowerCase();
  if (marketTitle && supplyTitle && marketTitle === supplyTitle) {
    return {
      linked: false,
      salesEligible: false,
      method: "title",
      confidence: 0.2,
      rationale: "title-only match is not an identity confirmation",
    };
  }

  return {
    linked: false,
    salesEligible: false,
    method: "none",
    confidence: 0,
    rationale: "no identifier overlap",
  };
}

export function verifyIdentifierMatchInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const asin = matchProductIdentity({
    market: { ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN", title: "A" },
    supply: { ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN", title: "Different" },
  });
  const titleOnly = matchProductIdentity({
    market: { ...EMPTY_IDENTIFIERS, title: "Wireless Earbuds" },
    supply: { ...EMPTY_IDENTIFIERS, title: "Wireless Earbuds" },
  });
  const missing = matchProductIdentity({
    market: { ...EMPTY_IDENTIFIERS, title: "A" },
    supply: { ...EMPTY_IDENTIFIERS, title: "B" },
  });

  const cases = [
    {
      name: "asin_match_is_sales_eligible",
      expected: true,
      actual: asin.salesEligible && asin.method === "asin",
    },
    {
      name: "title_only_is_not_sales_eligible",
      expected: true,
      actual: titleOnly.salesEligible === false && titleOnly.method === "title",
    },
    {
      name: "no_overlap_is_not_guessed",
      expected: true,
      actual: missing.method === "none" && missing.linked === false,
    },
    {
      name: "pick_identifier_prefers_jan_over_asin",
      expected: true,
      actual:
        pickIdentifierQuery({ ...EMPTY_IDENTIFIERS, jan: "4573138107287", asin: "B0TESTASIN" }) ===
        "4573138107287",
    },
    {
      name: "pick_identifier_falls_back_to_asin_when_no_barcode",
      expected: true,
      actual: pickIdentifierQuery({ ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN" }) === "B0TESTASIN",
    },
    {
      name: "pick_identifier_falls_back_to_mpn_last",
      expected: true,
      actual: pickIdentifierQuery({ ...EMPTY_IDENTIFIERS, mpn: "ABC-123" }) === "ABC-123",
    },
    {
      name: "pick_identifier_null_when_nothing_present",
      expected: true,
      actual: pickIdentifierQuery(EMPTY_IDENTIFIERS) === null,
    },
  ];

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
