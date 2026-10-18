export type PublicationRepairItem = {
  itemId: string;
  sku: string | null;
  visible: boolean | null;
  price: number | null;
};

export type DeletePair = {
  staleId: string;
  canonicalId: string;
  sku: string;
  price: number;
};

export type HidePair = DeletePair & {
  canonicalVisible: boolean;
};

/** Hidden duplicates whose channel listing already points at a visible canonical item. */
export const HIDDEN_DUPLICATE_DELETES: DeletePair[] = [
  { staleId: "163125132", canonicalId: "163240276", sku: "TRC-2063580BEEED461580958BD2", price: 2964 },
  { staleId: "163125145", canonicalId: "163240081", sku: "TRC-70DAC828F1984A75BABD539C", price: 2964 },
  { staleId: "163130238", canonicalId: "163240521", sku: "TRC-6F1BC5912E694CF799BC38BB", price: 5194 },
  { staleId: "163159274", canonicalId: "163159273", sku: "TRC-015C4A01F2694EBC8A868B57", price: 4314 },
  { staleId: "163159329", canonicalId: "163159682", sku: "TRC-521C3D01E4B741868E8D1345", price: 1458 },
];

/**
 * Visible items that are not the DB row. 163159679 duplicates the published canonical.
 * 163159245 duplicates the hidden error row 163159246, so it must not stay on sale.
 */
export const VISIBLE_NONCANONICAL_HIDES: HidePair[] = [
  { staleId: "163159679", canonicalId: "163159682", sku: "TRC-521C3D01E4B741868E8D1345", price: 1458, canonicalVisible: true },
  { staleId: "163159245", canonicalId: "163159246", sku: "TRC-CD39130EFD9F48EBB654DF9B", price: 2386, canonicalVisible: false },
];

/** BASE is already hidden. The DB error is the reason it is off sale, so the row is not rewritten. */
export const ERROR_HIDDEN_LEAVE: Array<{ itemId: string; sku: string; price: number }> = [
  { itemId: "163159169", sku: "TRC-93135EF6AFA041DC9B62F282", price: 1846 },
  { itemId: "163159246", sku: "TRC-CD39130EFD9F48EBB654DF9B", price: 2386 },
  { itemId: "163159307", sku: "TRC-47764FBB44634AF681E42173", price: 7148 },
  { itemId: "163182794", sku: "TRC-5E9AC91B718544139984AF7A", price: 12566 },
  { itemId: "163182796", sku: "TRC-FC41A1D350304A6899D60549", price: 12566 },
];

function same(item: PublicationRepairItem | undefined, id: string, sku: string, price: number, visible: boolean) {
  if (!item || item.itemId !== id) return "item_missing";
  if (item.sku !== sku) return "sku_mismatch";
  if (item.price !== price) return "price_mismatch";
  if (item.visible !== visible) return "visibility_mismatch";
  return null;
}

export function assessHiddenDelete(pair: DeletePair, items: Map<string, PublicationRepairItem>, listingExternalId: string | null) {
  const staleReason = same(items.get(pair.staleId), pair.staleId, pair.sku, pair.price, false);
  const canonicalReason = same(items.get(pair.canonicalId), pair.canonicalId, pair.sku, pair.price, true);
  if (staleReason) return { ok: false as const, reason: `stale_${staleReason}` };
  if (canonicalReason) return { ok: false as const, reason: `canonical_${canonicalReason}` };
  if (listingExternalId !== pair.canonicalId) return { ok: false as const, reason: "listing_does_not_point_at_canonical" };
  return { ok: true as const };
}

export function assessVisibleHide(pair: HidePair, items: Map<string, PublicationRepairItem>, listingExternalId: string | null) {
  const staleReason = same(items.get(pair.staleId), pair.staleId, pair.sku, pair.price, true);
  const canonicalReason = same(items.get(pair.canonicalId), pair.canonicalId, pair.sku, pair.price, pair.canonicalVisible);
  if (staleReason) return { ok: false as const, reason: `stale_${staleReason}` };
  if (canonicalReason) return { ok: false as const, reason: `canonical_${canonicalReason}` };
  if (listingExternalId !== pair.canonicalId) return { ok: false as const, reason: "listing_does_not_point_at_canonical" };
  return { ok: true as const };
}

export function assessErrorHidden(target: { itemId: string; sku: string; price: number }, items: Map<string, PublicationRepairItem>, listing: { externalId: string | null; status: string | null } | null) {
  const reason = same(items.get(target.itemId), target.itemId, target.sku, target.price, false);
  if (reason) return { ok: false as const, reason };
  if (!listing || listing.externalId !== target.itemId || listing.status !== "error") {
    return { ok: false as const, reason: "db_link_or_status_changed" };
  }
  return { ok: true as const, action: "leave_db_error_base_already_hidden" as const };
}
