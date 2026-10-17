/**
 * Exact BASE identifier matching. Never matches by title, price, or image.
 * Legacy shop rows use TRC-<shop_listings uuid>. Commerce rows use
 * TRC- plus the first 24 hex characters of the variant UUID.
 */

const LEGACY_TRACER_IDENTIFIER = /^TRC-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const COMMERCE_TRACER_SKU = /^TRC-([0-9a-f]{24})$/i;

export type BaseIdentifier =
  | { kind: "missing" }
  | { kind: "legacy_uuid"; listingId: string }
  | { kind: "commerce_sku"; sku: string }
  | { kind: "other" };

export function classifyBaseIdentifier(identifier: string | null | undefined): BaseIdentifier {
  const value = typeof identifier === "string" ? identifier.trim() : "";
  if (!value) return { kind: "missing" };
  const legacy = value.match(LEGACY_TRACER_IDENTIFIER);
  if (legacy?.[1]) return { kind: "legacy_uuid", listingId: legacy[1].toLowerCase() };
  const commerce = value.match(COMMERCE_TRACER_SKU);
  if (commerce?.[1]) return { kind: "commerce_sku", sku: "TRC-" + commerce[1].toUpperCase() };
  return { kind: "other" };
}

export type CommerceListingRef = { id: string; externalProductId: string | null };

export type CommerceLinkDecision = {
  outcome:
    | "repairable"
    | "repairable_stale_external_id"
    | "already_linked"
    | "listing_has_different_base_item"
    | "base_item_already_mapped"
    | "ambiguous_sku"
    | "ambiguous_base_item"
    | "no_listing";
  listingId?: string;
  previousExternalProductId?: string;
};

/** One BASE item, one commerce SKU, one channel listing, and a null external id. */
export function decideCommerceSkuLink(input: {
  baseItemId: string;
  listingsForSku: CommerceListingRef[];
  otherBaseItemIdsWithSameSku: string[];
  listingIdsAlreadyUsingBaseItem: string[];
  /** True only when the complete BASE snapshot still contains the current external ID. */
  currentExternalIdExists?: boolean;
}): CommerceLinkDecision {
  if (input.listingsForSku.length !== 1) {
    return { outcome: input.listingsForSku.length === 0 ? "no_listing" : "ambiguous_sku" };
  }
  const listing = input.listingsForSku[0];
  if (input.otherBaseItemIdsWithSameSku.length > 0) return { outcome: "ambiguous_base_item", listingId: listing.id };
  const current = listing.externalProductId;
  const conflicts = input.listingIdsAlreadyUsingBaseItem.filter((id) => id !== listing.id);
  if (conflicts.length > 0) return { outcome: "base_item_already_mapped", listingId: listing.id };
  if (current === input.baseItemId) return { outcome: "already_linked", listingId: listing.id };
  if (current) {
    if (input.currentExternalIdExists === false) {
      return { outcome: "repairable_stale_external_id", listingId: listing.id, previousExternalProductId: current };
    }
    return { outcome: "listing_has_different_base_item", listingId: listing.id };
  }
  return { outcome: "repairable", listingId: listing.id };
}
