export type BaseMappingCounts = {
  kind: "none" | "commerce" | "legacy" | "ambiguous";
};

/**
 * Classify exact BASE item-ID matches across the active commerce and retired
 * legacy tables. One active commerce mapping wins over stale legacy copies from
 * migration. Multiple active commerce rows remain ambiguous; legacy rows are
 * considered only when no active commerce row exists.
 */
export function classifyBaseMappingCounts(
  legacyMatchCount: number,
  commerceMatchCount: number,
): BaseMappingCounts {
  const legacy = Math.max(0, Math.floor(legacyMatchCount));
  const commerce = Math.max(0, Math.floor(commerceMatchCount));

  if (commerce > 1) return { kind: "ambiguous" };
  if (commerce === 1) return { kind: "commerce" };
  if (legacy > 1) return { kind: "ambiguous" };
  if (legacy === 1) return { kind: "legacy" };
  return { kind: "none" };
}
