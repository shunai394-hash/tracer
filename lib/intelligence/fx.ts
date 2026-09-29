import "server-only";

type FxQuote = {
  base: string;
  quote: string;
  rate: number;
  fetchedAt: string;
  source: string;
};

const cached = new Map<string, FxQuote>();

const CACHE_MS = 60 * 60 * 1000;

export async function getObservedFxRate(baseCurrency: string, quoteCurrency: string): Promise<FxQuote | null> {
  const base = baseCurrency.trim().toUpperCase();
  const quote = quoteCurrency.trim().toUpperCase();
  if (!base || !quote) return null;
  if (base === quote) {
    return { base, quote, rate: 1, fetchedAt: new Date().toISOString(), source: "identity" };
  }

  const key = base + "->" + quote;
  const now = Date.now();
  const previous = cached.get(key);
  if (previous && now - new Date(previous.fetchedAt).getTime() < CACHE_MS) return previous;

  try {
    const url = "https://api.frankfurter.app/latest?from=" +
      encodeURIComponent(base) + "&to=" + encodeURIComponent(quote);
    const response = await fetch(url, {
      headers: { "User-Agent": "TRACER/1.0 FX Intelligence" },
      cache: "no-store",
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { rates?: Record<string, unknown> };
    const rate = typeof data.rates?.[quote] === "number" ? data.rates[quote] : null;
    if (!rate || !Number.isFinite(rate) || rate <= 0) return null;

    const result: FxQuote = {
      base,
      quote,
      rate,
      fetchedAt: new Date().toISOString(),
      source: "Frankfurter/ECB reference rates",
    };
    cached.set(key, result);
    return result;
  } catch {
    return null;
  }
}

export async function getObservedUsdToJpyRate(): Promise<FxQuote | null> {
  return getObservedFxRate("USD", "JPY");
}
