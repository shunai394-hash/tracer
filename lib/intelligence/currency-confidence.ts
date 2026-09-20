import type { CurrencyConfidence } from "@/lib/domain/types";

export type CurrencyAssessment = {
  confidence: CurrencyConfidence;
  reasons: string[];
};

const ISO_CURRENCIES = new Set([
  "USD",
  "JPY",
  "EUR",
  "GBP",
  "CNY",
  "KRW",
  "AUD",
  "CAD",
  "TWD",
  "HKD",
]);

function normalizeCurrency(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

function hasFractionalCents(price: number): boolean {
  return Math.abs(price - Math.round(price)) > 0.0001;
}

/**
 * Detect mislabeled money. Existing product_offers sometimes store
 * JPY-like integers under a USD label. Those must not enter profit math.
 */
export function assessCurrencyConfidence(args: {
  currency: string | null | undefined;
  price: number | null | undefined;
  provider?: string | null;
}): CurrencyAssessment {
  const reasons: string[] = [];
  const currency = normalizeCurrency(args.currency);
  const price =
    typeof args.price === "number" && Number.isFinite(args.price)
      ? args.price
      : null;
  const provider = args.provider?.trim().toLowerCase() ?? null;

  if (price === null || price <= 0) {
    return {
      confidence: "unknown",
      reasons: ["price_missing"],
    };
  }

  if (!currency) {
    return {
      confidence: "unknown",
      reasons: ["currency_missing"],
    };
  }

  if (!ISO_CURRENCIES.has(currency)) {
    return {
      confidence: "unknown",
      reasons: [`currency_unrecognized:${currency}`],
    };
  }

  if (currency === "USD" || currency === "EUR" || currency === "GBP" || currency === "AUD" || currency === "CAD") {
    if (price >= 1000 && !hasFractionalCents(price)) {
      reasons.push("integer_amount_looks_like_jpy");
      return { confidence: "low", reasons };
    }

    if (price >= 5000) {
      reasons.push("usd_amount_implausibly_high");
      return { confidence: "low", reasons };
    }

    if (price >= 800 && !hasFractionalCents(price)) {
      reasons.push("large_integer_usd_uncertain");
      return { confidence: "medium", reasons };
    }

    if (provider === "cj" && price <= 500) {
      reasons.push("cj_catalog_usd_range");
      return { confidence: "high", reasons };
    }

    if (hasFractionalCents(price) && price < 800) {
      reasons.push("fractional_major_currency");
      return { confidence: "high", reasons };
    }

    if (price < 300) {
      reasons.push("typical_major_currency_range");
      return { confidence: "high", reasons };
    }

    reasons.push("elevated_major_currency_amount");
    return { confidence: "medium", reasons };
  }

  if (currency === "JPY" || currency === "KRW") {
    if (hasFractionalCents(price)) {
      reasons.push("fractional_yen_like_currency");
      return { confidence: "low", reasons };
    }

    if (price < 50) {
      reasons.push("yen_amount_looks_like_usd");
      return { confidence: "low", reasons };
    }

    if (price < 100) {
      reasons.push("low_yen_amount");
      return { confidence: "medium", reasons };
    }

    reasons.push("typical_yen_range");
    return { confidence: "high", reasons };
  }

  reasons.push("supported_currency_without_specific_heuristic");
  return { confidence: "medium", reasons };
}

export function isCurrencyReliable(
  confidence: CurrencyConfidence | null | undefined,
): boolean {
  return confidence === "high" || confidence === "medium";
}

export function verifyCurrencyConfidenceInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: CurrencyConfidence; actual: CurrencyConfidence }>;
} {
  const fixtures: Array<{
    name: string;
    expected: CurrencyConfidence;
    input: Parameters<typeof assessCurrencyConfidence>[0];
  }> = [
    {
      name: "usd_labeled_jpy_amount",
      expected: "low",
      input: { currency: "USD", price: 12800, provider: "brightdata" },
    },
    {
      name: "usd_labeled_integer_thousand",
      expected: "low",
      input: { currency: "USD", price: 3980, provider: "brightdata" },
    },
    {
      name: "cj_usd_source_cost",
      expected: "high",
      input: { currency: "USD", price: 3.38, provider: "cj" },
    },
    {
      name: "typical_usd_market",
      expected: "high",
      input: { currency: "USD", price: 29.99, provider: "brightdata" },
    },
    {
      name: "missing_currency",
      expected: "unknown",
      input: { currency: null, price: 20 },
    },
    {
      name: "jpy_typical",
      expected: "high",
      input: { currency: "JPY", price: 12800 },
    },
    {
      name: "jpy_labeled_usd_amount",
      expected: "low",
      input: { currency: "JPY", price: 19.99 },
    },
  ];

  const cases = fixtures.map((fixture) => {
    const actual = assessCurrencyConfidence(fixture.input).confidence;
    return { name: fixture.name, expected: fixture.expected, actual };
  });

  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
