// Test double for "@/lib/intelligence/fx": no network; JPY-only fixtures need no rate.
export async function getObservedFxRate(base, quote) {
  return base === quote ? { base, quote, rate: 1, fetchedAt: new Date(0).toISOString(), source: "identity" } : null;
}
export async function getObservedUsdToJpyRate() {
  return null;
}
