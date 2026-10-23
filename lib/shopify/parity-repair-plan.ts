/**
 * Pure plan for bringing Shopify's live catalog back in line with TRACER.
 * Only live products (ACTIVE and on the Online Store) are examined, and a
 * product is matched to TRACER rows by Shopify product id or SKU, never by
 * title. The only write it can propose is "draft": nothing is deleted, and a
 * product that cannot be matched is left for manual review.
 */

export type ParityNode = {
  id: string;
  handle: string;
  status: string;
  vendor: string | null;
  publishedOnPublication: boolean;
  variants: Array<{ id: string; sku: string | null }>;
};

export type ParityCommerceRow = {
  id: string;
  variant_id: string;
  external_product_id: string | null;
  external_sku: string | null;
  status: string;
  last_error?: string | null;
};

export type ParityLegacyRow = { id: string; published: boolean | null; shopify_product_id: string | null };

export type ParityDecision = {
  shopifyProductId: string;
  handle: string;
  skus: string[];
  action: "keep" | "draft" | "manual_review";
  reason: string;
  channelListingId: string | null;
  variantId: string | null;
  legacyListingId: string | null;
  linkedProductId: string | null;
};

const tail = (id: unknown) => String(id ?? "").split("/").pop() ?? "";
const LEGACY_SKU = /^TRC-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function canonicalCommerceSku(variantId: string): string {
  return ("TRC-" + variantId.replace(/-/g, "").slice(0, 24)).toUpperCase();
}

export function legacyListingIdFromSku(sku: string | null): string | null {
  const match = LEGACY_SKU.exec(String(sku ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

export function planShopifyParityRepair(input: {
  nodes: ParityNode[];
  commerceRows: ParityCommerceRow[];
  legacyRows: ParityLegacyRow[];
}): ParityDecision[] {
  const rowsByProduct = new Map<string, ParityCommerceRow[]>();
  const rowsBySku = new Map<string, ParityCommerceRow[]>();
  const add = (map: Map<string, ParityCommerceRow[]>, key: string, row: ParityCommerceRow) => {
    if (!key) return;
    const rows = map.get(key) ?? [];
    if (!rows.includes(row)) rows.push(row);
    map.set(key, rows);
  };
  for (const row of input.commerceRows) {
    add(rowsByProduct, tail(row.external_product_id), row);
    add(rowsBySku, canonicalCommerceSku(row.variant_id), row);
    add(rowsBySku, String(row.external_sku ?? "").trim().toUpperCase(), row);
  }
  const legacyById = new Map(input.legacyRows.map((row) => [row.id.toLowerCase(), row]));
  const legacyByProduct = new Map<string, ParityLegacyRow[]>();
  for (const row of input.legacyRows) {
    const key = tail(row.shopify_product_id);
    if (key) legacyByProduct.set(key, [...(legacyByProduct.get(key) ?? []), row]);
  }

  const decisions: ParityDecision[] = [];
  for (const node of input.nodes) {
    if (node.vendor !== "TRACER" || node.status !== "ACTIVE" || node.publishedOnPublication !== true) continue;
    const productTail = tail(node.id);
    const skus = node.variants.map((variant) => String(variant.sku ?? "").trim()).filter(Boolean);
    const base = { shopifyProductId: node.id, handle: node.handle, skus, channelListingId: null, variantId: null, legacyListingId: null, linkedProductId: null };
    const decide = (decision: Partial<ParityDecision> & Pick<ParityDecision, "action" | "reason">) => decisions.push({ ...base, ...decision });

    const byProduct = rowsByProduct.get(productTail) ?? [];
    if (byProduct.length > 1) {
      decide({ action: "manual_review", reason: "multiple_channel_listings_share_product_id" });
      continue;
    }
    if (byProduct.length === 1) {
      const row = byProduct[0];
      const refs = { channelListingId: row.id, variantId: row.variant_id };
      if (row.status === "published") decide({ ...refs, action: "keep", reason: "linked_published_channel_listing" });
      else decide({ ...refs, action: "draft", reason: "linked_channel_listing_status_" + row.status + (row.last_error ? ":" + String(row.last_error).slice(0, 80) : "") });
      continue;
    }

    const bySku = [...new Set(skus.flatMap((sku) => rowsBySku.get(sku.toUpperCase()) ?? []))];
    if (bySku.length > 1) {
      decide({ action: "manual_review", reason: "sku_matches_multiple_channel_listings" });
      continue;
    }
    if (bySku.length === 1) {
      const row = bySku[0];
      const linked = tail(row.external_product_id);
      const refs = { channelListingId: row.id, variantId: row.variant_id, linkedProductId: row.external_product_id };
      if (row.status !== "published") decide({ ...refs, action: "draft", reason: "sku_matches_unpublished_channel_listing_status_" + row.status });
      else if (linked && linked !== productTail) decide({ ...refs, action: "draft", reason: "duplicate_sku_of_linked_product" });
      // Published row with no product id yet: the publisher links it; never guess here.
      else decide({ ...refs, action: "manual_review", reason: "sku_matches_published_row_without_product_id" });
      continue;
    }

    const legacyMatches = [...new Set([
      ...(legacyByProduct.get(productTail) ?? []),
      ...skus.map(legacyListingIdFromSku).flatMap((id) => (id && legacyById.get(id) ? [legacyById.get(id)!] : [])),
    ])];
    if (legacyMatches.length > 1) {
      decide({ action: "manual_review", reason: "multiple_legacy_listings_match" });
      continue;
    }
    if (legacyMatches.length === 1) {
      const legacy = legacyMatches[0];
      if (legacy.published === true) decide({ legacyListingId: legacy.id, action: "keep", reason: "legacy_listing_published" });
      else decide({ legacyListingId: legacy.id, action: "draft", reason: "legacy_listing_unpublished" });
      continue;
    }
    decide({ action: "manual_review", reason: skus.some((sku) => legacyListingIdFromSku(sku)) ? "legacy_sku_listing_missing" : "unmatched_by_id_or_sku" });
  }
  return decisions;
}
