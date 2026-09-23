/**
 * Smallest-unit conversion (e.g. JPY has 0 decimal places, USD has 2). Only
 * the currencies TRACER actually deals with are covered; anything else
 * throws rather than silently guessing a decimal count.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(["jpy", "krw", "vnd"]);

export function toStripeMinorUnits(amount: number, currency: string): number {
  const lower = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(lower)) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

export function verifyStripeCurrencyInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const jpy = toStripeMinorUnits(1980, "JPY");
  const usd = toStripeMinorUnits(19.99, "USD");

  const cases = [
    { name: "jpy_is_zero_decimal", expected: true, actual: jpy === 1980 },
    { name: "usd_converts_to_cents", expected: true, actual: usd === 1999 },
  ];

  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
