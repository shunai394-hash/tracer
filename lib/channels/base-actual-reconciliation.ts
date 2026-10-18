/**
 * Pure comparison of a complete BASE /items snapshot with channel_listings.
 * BASE-only items stay in the result. Nothing here writes or guesses a link.
 */

export type BaseChannelListing = {
  id: string;
  variantId: string;
  externalProductId: string | null;
  externalVariantId: string | null;
  externalSku: string | null;
  sellingPrice: number | null;
  status: string | null;
};

export type BaseReconciliationItem = {
  baseItemId: string | null;
  title: string | null;
  baseIdentifier: string | null;
  basePrice: number | null;
  tracerVariantId: string | null;
  tracerSku: string | null;
  tracerPrice: number | null;
  baseVisibility: boolean | null;
  dbStatus: string | null;
  existingExternalProductId: string | null;
  mappingStatus: "matched" | "unmapped" | "ambiguous" | "id_conflict";
  mappingMethod: "base_item_id" | "exact_sku" | "none";
  candidateCount: number;
  candidateListingIds: string[];
  priceMatches: boolean | null;
  skuMatches: boolean | null;
  publicationMatches: boolean | null;
  discrepancyReasons: string[];
};

export type BaseAuditInsertRow = {
  channel: "base";
  external_product_id: string | null;
  external_variant_id: string | null;
  variant_id: string | null;
  external_sku: string | null;
  internal_sku: string | null;
  product_title: string | null;
  external_price: number | null;
  canonical_price: number | null;
  db_channel_price: number | null;
  product_status: string;
  price_matches: boolean | null;
  sku_matches: boolean | null;
  details: Record<string, unknown>;
};

function textValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function priceValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function visibleValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

/** Known BASE visibility disagrees with a publication status. error and pending are workflow states. */
export function publicationAgrees(visible: boolean | null, status: string | null): boolean | null {
  if (visible === null || !status) return null;
  if (status !== "published" && status !== "hidden") return null;
  return visible ? status === "published" : status === "hidden";
}

export function reconcileBaseItems(snapshotItems: Record<string, unknown>[], listings: BaseChannelListing[]) {
  const byExternalId = new Map<string, BaseChannelListing[]>();
  const bySku = new Map<string, BaseChannelListing[]>();
  for (const row of listings) {
    const externalId = textValue(row.externalProductId);
    if (externalId) {
      const group = byExternalId.get(externalId) ?? [];
      group.push(row);
      byExternalId.set(externalId, group);
    }
    const sku = textValue(row.externalSku)?.toUpperCase();
    if (sku) {
      const group = bySku.get(sku) ?? [];
      group.push(row);
      bySku.set(sku, group);
    }
  }

  const built = snapshotItems.map((item) => {
    const externalId = textValue(item.item_id);
    const identifier = textValue(item.identifier);
    const idCandidates = externalId ? byExternalId.get(externalId) ?? [] : [];
    const skuCandidates = identifier ? bySku.get(identifier.toUpperCase()) ?? [] : [];
    const candidates = idCandidates.length > 0 ? idCandidates : skuCandidates;
    const mappingMethod = idCandidates.length > 0 ? "base_item_id" : skuCandidates.length > 0 ? "exact_sku" : "none";
    const listing = candidates.length === 1 ? candidates[0] : null;
    const skuPointsToDifferentId = idCandidates.length === 0
      && skuCandidates.length === 1
      && externalId !== null
      && textValue(skuCandidates[0].externalProductId) !== null
      && textValue(skuCandidates[0].externalProductId) !== externalId;
    const mappingStatus = candidates.length === 0
      ? "unmapped"
      : candidates.length > 1
        ? "ambiguous"
        : skuPointsToDifferentId
          ? "id_conflict"
          : "matched";
    const externalPrice = priceValue(item.price);
    const visible = visibleValue(item.visible);
    const canonicalPrice = listing && Number.isFinite(Number(listing.sellingPrice)) ? Number(listing.sellingPrice) : null;
    const trustedListing = mappingStatus === "matched" ? listing : null;
    const priceMatches = trustedListing && externalPrice !== null && canonicalPrice !== null
      ? Math.round(externalPrice) === Math.round(canonicalPrice)
      : null;
    const skuMatches = listing && identifier
      ? identifier.toUpperCase() === String(listing.externalSku ?? "").toUpperCase()
      : null;
    const publicationMatches = trustedListing ? publicationAgrees(visible, trustedListing.status) : null;
    const reasons = [
      ...(candidates.length === 0 ? ["no_db_mapping"] : []),
      ...(mappingStatus === "unmapped" && !identifier ? ["missing_sku"] : []),
      ...(mappingStatus === "unmapped" && identifier ? ["sku_not_in_tracer"] : []),
      ...(candidates.length > 1 ? ["ambiguous_db_mapping"] : []),
      ...(skuPointsToDifferentId ? ["base_item_id_conflict"] : []),
      ...(visible === null ? ["visibility_unreadable"] : []),
      ...(externalPrice === null ? ["external_price_unreadable"] : []),
      ...(priceMatches === false ? ["price_mismatch"] : []),
      ...(skuMatches === false ? ["identifier_sku_mismatch"] : []),
      ...(publicationMatches === false ? ["publication_mismatch"] : []),
    ];
    const view: BaseReconciliationItem = {
      baseItemId: externalId,
      title: textValue(item.title),
      baseIdentifier: identifier,
      basePrice: externalPrice,
      tracerVariantId: mappingStatus === "matched" ? listing?.variantId ?? null : null,
      tracerSku: listing?.externalSku ?? null,
      tracerPrice: canonicalPrice,
      baseVisibility: visible,
      dbStatus: listing?.status ?? null,
      existingExternalProductId: listing?.externalProductId ?? null,
      mappingStatus,
      mappingMethod,
      candidateCount: candidates.length,
      candidateListingIds: candidates.map((candidate) => candidate.id),
      priceMatches,
      skuMatches,
      publicationMatches,
      discrepancyReasons: reasons,
    };
    const row: BaseAuditInsertRow = {
      channel: "base",
      external_product_id: externalId,
      external_variant_id: listing?.externalVariantId ?? null,
      variant_id: mappingStatus === "matched" ? listing?.variantId ?? null : null,
      external_sku: identifier,
      internal_sku: listing?.externalSku ?? null,
      product_title: view.title,
      external_price: externalPrice,
      canonical_price: canonicalPrice,
      db_channel_price: canonicalPrice,
      product_status: visible === null ? "visibility_unknown" : visible ? "published" : "hidden",
      price_matches: priceMatches,
      sku_matches: skuMatches,
      details: {
        source: "base_items_api",
        apiVisible: visible,
        mappingCount: candidates.length,
        mappingStatus,
        mappingMethod,
        candidateListingIds: view.candidateListingIds,
        dbListingStatus: listing?.status ?? null,
        existingExternalProductId: listing?.externalProductId ?? null,
        publicationMatches,
        discrepancyReasons: reasons,
      },
    };
    return { view, row };
  });

  const views = built.map((entry) => entry.view);
  const count = (predicate: (item: BaseReconciliationItem) => boolean) => views.filter(predicate).length;
  return {
    items: views,
    rows: built.map((entry) => entry.row),
    summary: {
      itemCount: views.length,
      dbListingCount: listings.length,
      mappedItems: count((item) => item.mappingStatus === "matched"),
      exactIdMatches: count((item) => item.mappingMethod === "base_item_id" && item.mappingStatus === "matched"),
      exactSkuMatches: count((item) => item.mappingMethod === "exact_sku" && item.mappingStatus === "matched"),
      idConflicts: count((item) => item.mappingStatus === "id_conflict"),
      unmappedItems: count((item) => item.mappingStatus === "unmapped"),
      ambiguousItems: count((item) => item.mappingStatus === "ambiguous"),
      missingSku: count((item) => !item.baseIdentifier),
      unknownVisibility: count((item) => item.baseVisibility === null),
      unreadablePrices: count((item) => item.basePrice === null),
      priceMismatches: count((item) => item.priceMatches === false),
      skuMismatches: count((item) => item.skuMatches === false),
      publicationMismatches: count((item) => item.publicationMatches === false),
    },
  };
}

export type ConfirmedPriceSyncDecision =
  | { ok: true; listingId: string; canonicalPrice: number }
  | { ok: false; reason: string };

/** Price may move only after one listing is already tied to this BASE item and the SKU agrees. */
export function decideConfirmedPriceSync(input: {
  baseItemId: string;
  baseIdentifier: string | null;
  basePrice: number | null;
  listings: BaseChannelListing[];
}): ConfirmedPriceSyncDecision {
  const linked = input.listings.filter((row) => textValue(row.externalProductId) === input.baseItemId);
  const identifier = textValue(input.baseIdentifier);
  if (!identifier) return { ok: false, reason: "sku_not_exact" };

  // If BASE's item ID differs from TRACER's stored ID, a price-only repair is
  // allowed only when this exact SKU resolves to one listing whose prior
  // external ID is known. The caller must also prove the SKU is unique in the
  // complete live BASE snapshot. Never rewrite the external ID here.
  let listing: BaseChannelListing;
  const matchedByExactItemId = linked.length === 1;
  if (matchedByExactItemId) {
    listing = linked[0];
  } else if (linked.length > 1) {
    return { ok: false, reason: "ambiguous_item_id" };
  } else {
    const skuCandidates = input.listings.filter(
      (row) => textValue(row.externalSku)?.toUpperCase() === identifier.toUpperCase(),
    );
    if (skuCandidates.length !== 1) {
      return { ok: false, reason: skuCandidates.length === 0 ? "not_linked_by_item_id" : "ambiguous_sku" };
    }
    if (!textValue(skuCandidates[0].externalProductId)) {
      return { ok: false, reason: "sku_candidate_has_no_existing_external_id" };
    }
    listing = skuCandidates[0];
  }
  const sku = textValue(listing.externalSku);
  if (!sku || identifier.toUpperCase() !== sku.toUpperCase()) {
    return { ok: false, reason: "sku_not_exact" };
  }
  // An exact, unique BASE item ID plus exact SKU is sufficient even if another
  // listing reuses that SKU. Without an exact item-ID link, SKU fallback must
  // remain unique across the database listings.
  const sameSku = input.listings.filter((row) => textValue(row.externalSku)?.toUpperCase() === sku.toUpperCase());
  if (!matchedByExactItemId && sameSku.length !== 1) return { ok: false, reason: "ambiguous_sku" };
  const canonical = Number(listing.sellingPrice);
  if (!Number.isInteger(canonical) || canonical <= 0) return { ok: false, reason: "canonical_price_invalid" };
  if (input.basePrice === null || !Number.isFinite(input.basePrice)) return { ok: false, reason: "base_price_unreadable" };
  if (Math.round(input.basePrice) === canonical) return { ok: false, reason: "already_matched" };
  return { ok: true, listingId: listing.id, canonicalPrice: canonical };
}
