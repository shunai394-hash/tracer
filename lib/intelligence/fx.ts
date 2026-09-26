import "server-only";

type FxQuote = {
  base: string;
  quote: string;
  rate: number;
  fetchedAt: string;
  source: string;
};

let cached: FxQuote | null = null;

const FX_URL = "https://api.frankfurter.app/latest?from=USD&to=JPY";
const CACHE_MS = 60 * 60 * 1000;

export async function getObservedUsdToJpyRate(): Promise<FxQuote | null> {
  const now = Date.now();
  if (cached && now - new Date(cached.fetchedAt).getTime() < CACHE_MS) {
    return cached;
  }

  try {
    const response = await fetch(FX_URL, {
      headers: { "User-Agent": "TRACER/1.0 FX Intelligence" },
      cache: "no-store",
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      base?: unknown;
      date?: unknown;
      rates?: Record<string, unknown>;
    };
    const rate = typeof body.rates?.JPY === "number" ? body.rates.JPY : null;
    if (!rate || !Number.isFinite(rate) || rate <= 0) return null;

    cached = {
      base: "USD",
      quote: "JPY",
      rate,
      fetchedAt: new Date().toISOString(),
      source: "Frankfurter/ECB reference rates",
    };
    return cached;
  } catch {
    return null;
  }
}
