/** Pure timestamp gate shared by Shopify sync and behavior tests. */
export function timestampIsFresh(
  value: string | null | undefined,
  maxAgeMs: number,
  now = Date.now(),
): boolean {
  if (!value || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAgeMs;
}
