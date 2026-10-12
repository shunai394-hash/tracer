export type SupplierMatchInput = {
  supplierProductId?: string | null;
  supplierVariantId?: string | null;
  imageUrl?: string | null;
  title?: string | null;
  specs?: Record<string, string | number | boolean | null | undefined> | null;
};
export type SupplierCandidate = SupplierMatchInput & { id: string };
export type CandidateEvidence = {
  candidateId: string;
  score: number;
  reasons: string[];
  status: "review" | "unique_candidate";
};
export type CandidateMatchResult = {
  status: "no_candidates" | "review_required" | "candidate_found";
  candidates: CandidateEvidence[];
  duplicateSupplierIds: string[];
};

function norm(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function normalizedUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    url.hash = "";
    // Keep query strings: supplier URLs may encode product/variant identity.
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}
function titleTokens(value: string | null | undefined): Set<string> {
  return new Set(norm(value).split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 2));
}
function titleScore(left: string | null | undefined, right: string | null | undefined): number {
  const a = titleTokens(left), b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}
function specScore(
  left: SupplierMatchInput["specs"],
  right: SupplierMatchInput["specs"],
): { score: number; matches: string[]; conflicts: string[] } {
  const matches: string[] = [], conflicts: string[] = [];
  if (!left || !right) return { score: 0, matches, conflicts };
  for (const [key, value] of Object.entries(left)) {
    if (value == null || norm(value) === "") continue;
    const other = Object.entries(right).find(([otherKey]) => norm(otherKey) === norm(key))?.[1];
    if (other == null || norm(other) === "") continue;
    if (norm(value) === norm(other)) matches.push(key);
    else conflicts.push(key);
  }
  return { score: matches.length ? matches.length / (matches.length + conflicts.length) : 0, matches, conflicts };
}

/**
 * Generates review candidates only. Even an exact supplier ID does not itself
 * authorize publishing or ordering; variant, stock, cost, shipping and orderability
 * are separate gates. Any duplicate supplier identifier or close top scores
 * remain manual-review cases.
 */
export function rankSupplierMatchCandidates(
  target: SupplierMatchInput,
  candidates: SupplierCandidate[],
): CandidateMatchResult {
  if (!candidates.length) return { status: "no_candidates", candidates: [], duplicateSupplierIds: [] };

  const idCounts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const id of [norm(candidate.supplierProductId), norm(candidate.supplierVariantId)]) {
      if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
  }
  const duplicateSupplierIds = [...idCounts].filter(([, count]) => count > 1).map(([id]) => id).sort();

  const ranked = candidates.map((candidate) => {
    let score = 0;
    const reasons: string[] = [];
    const targetVariant = norm(target.supplierVariantId), candidateVariant = norm(candidate.supplierVariantId);
    const targetProduct = norm(target.supplierProductId), candidateProduct = norm(candidate.supplierProductId);
    if (targetVariant && candidateVariant && targetVariant === candidateVariant) { score += 100; reasons.push("exact_supplier_variant_id"); }
    else if (targetProduct && candidateProduct && targetProduct === candidateProduct) { score += 80; reasons.push("exact_supplier_product_id"); }

    const targetImage = normalizedUrl(target.imageUrl), candidateImage = normalizedUrl(candidate.imageUrl);
    if (targetImage && candidateImage && targetImage === candidateImage) { score += 20; reasons.push("exact_image_url"); }

    const specs = specScore(target.specs, candidate.specs);
    if (specs.matches.length) { score += Math.round(20 * specs.score); reasons.push(`spec_matches:${specs.matches.join(",")}`); }
    if (specs.conflicts.length) { score -= Math.min(35, specs.conflicts.length * 15); reasons.push(`spec_conflicts:${specs.conflicts.join(",")}`); }

    const similarity = titleScore(target.title, candidate.title);
    if (similarity > 0) { score += Math.round(similarity * 30); reasons.push(`title_jaccard:${similarity.toFixed(3)}`); }
    if (!reasons.length) reasons.push("no_comparable_evidence");
    return { candidateId: candidate.id, score, reasons, status: "review" as const };
  }).sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));

  const top = ranked[0];
  const second = ranked[1];
  const topHasDuplicateId = candidates.some((candidate) => candidate.id === top.candidateId &&
    [norm(candidate.supplierProductId), norm(candidate.supplierVariantId)].some((id) => id && duplicateSupplierIds.includes(id)));
  const clearlySeparated = !second || top.score - second.score >= 15;
  const hasIdentityEvidence = top.reasons.some((reason) => reason === "exact_supplier_variant_id" || reason === "exact_supplier_product_id");
  const unique = !topHasDuplicateId && clearlySeparated && hasIdentityEvidence;
  return {
    status: unique ? "candidate_found" : "review_required",
    duplicateSupplierIds,
    candidates: ranked.map((candidate, index) => ({
      ...candidate,
      status: unique && index === 0 ? "unique_candidate" : "review",
    })),
  };
}
