/**
 * Parse a freight value only when CJ explicitly returns a valid number.
 * Zero is valid when it is present in a named freight field (free shipping);
 * missing, blank, malformed, negative, and non-finite values remain unknown.
 */
export function readCJFreightPrice(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}
