/**
 * Exact-query fallback used when AI query ideation is unavailable.
 * This only searches the observed demand phrase; it never approves identity,
 * procurement, or publication.
 */
export function deterministicCJProductQueries(demandQuery: string): string[] {
  const exactQuery = demandQuery.trim();
  return exactQuery ? [exactQuery] : [];
}
