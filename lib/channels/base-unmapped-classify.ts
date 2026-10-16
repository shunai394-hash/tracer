/**
 * Classifies a BASE item that no TRACER row claims by exact BASE item id.
 * Pure and read-only: the result says why the item is unmapped and whether a
 * safe, evidence-based link exists. It never proposes a link on title alone.
 */

export type UnmappedBaseCategory =
  | "commerce_sku_unlinked_repairable"
  | "commerce_sku_duplicate_of_linked_item"
  | "commerce_sku_unknown"
  | "legacy_uuid_repairable"
  | "legacy_uuid_linked_to_other_item"
  | "legacy_uuid_listing_missing"
  | "supplier_identifier_unique"
  | "supplier_identifier_ambiguous"
  | "title_duplicate_of_linked_item"
  | "title_unique_unlinked_candidate"
  | "title_ambiguous"
  | "no_evidence";

export type UnmappedCandidate = { listingId: string; existingBaseItemId: string | number | null };

export type UnmappedBaseInput = {
  identifier: string | null;
  /** The row a TRC-<uuid> (legacy) or TRC-<24hex> (commerce) identifier resolves to, or null. */
  stableMatch: UnmappedCandidate | null;
  supplierIdentifierMatches: UnmappedCandidate[];
  titleMatches: UnmappedCandidate[];
};

const LEGACY_TRC = /^TRC-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMERCE_TRC = /^TRC-[0-9a-f]{24}$/i;

const linked = (candidate: UnmappedCandidate) => String(candidate.existingBaseItemId ?? "").trim() !== "";

export function classifyUnmappedBaseItem(input: UnmappedBaseInput): { category: UnmappedBaseCategory; safeLinkListingId: string | null } {
  const identifier = String(input.identifier ?? "").trim();
  if (COMMERCE_TRC.test(identifier)) {
    if (!input.stableMatch) return { category: "commerce_sku_unknown", safeLinkListingId: null };
    return linked(input.stableMatch)
      ? { category: "commerce_sku_duplicate_of_linked_item", safeLinkListingId: null }
      : { category: "commerce_sku_unlinked_repairable", safeLinkListingId: input.stableMatch.listingId };
  }
  if (LEGACY_TRC.test(identifier)) {
    if (!input.stableMatch) return { category: "legacy_uuid_listing_missing", safeLinkListingId: null };
    return linked(input.stableMatch)
      ? { category: "legacy_uuid_linked_to_other_item", safeLinkListingId: null }
      : { category: "legacy_uuid_repairable", safeLinkListingId: input.stableMatch.listingId };
  }
  if (input.supplierIdentifierMatches.length === 1) return { category: "supplier_identifier_unique", safeLinkListingId: null };
  if (input.supplierIdentifierMatches.length > 1) return { category: "supplier_identifier_ambiguous", safeLinkListingId: null };
  if (input.titleMatches.length === 1) {
    return linked(input.titleMatches[0])
      ? { category: "title_duplicate_of_linked_item", safeLinkListingId: null }
      : { category: "title_unique_unlinked_candidate", safeLinkListingId: null };
  }
  if (input.titleMatches.length > 1) {
    return input.titleMatches.every(linked)
      ? { category: "title_duplicate_of_linked_item", safeLinkListingId: null }
      : { category: "title_ambiguous", safeLinkListingId: null };
  }
  return { category: "no_evidence", safeLinkListingId: null };
}
