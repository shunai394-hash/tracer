import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/** Returns only supplier listings whose canonical identity review is explicitly linked. */
export async function getLinkedSupplierListingIds(values: unknown[]): Promise<Set<string>> {
  const ids = [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  if (ids.length === 0) return new Set();

  const supabase = createSupabaseAdminClient();
  const linked = new Set<string>();
  // Keep PostgREST URLs comfortably below proxy/request-line limits when a
  // bounded catalog scan includes hundreds or thousands of supplier rows.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await supabase
      .from("supplier_listings")
      .select("id,identity_status")
      .in("id", batch);
    if (error) throw new Error(`supplier_identity_lookup_failed:${error.message}`);
    for (const row of data ?? []) {
      if (row.identity_status === "linked") linked.add(String(row.id));
    }
  }
  return linked;
}


export type CanonicalSupplierIdentityCandidate = {
  supplier_listing_id: string | null;
  product_id: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
};

/**
 * Return only supplier rows whose review is linked and whose canonical product,
 * external product ID, and exact variant ID match the shop listing. A linked
 * supplier row by itself is insufficient when the downstream listing was
 * populated with a different product or variant.
 */
export async function getExactlyLinkedSupplierListingIds(
  candidates: CanonicalSupplierIdentityCandidate[],
): Promise<Set<string>> {
  const byId = new Map<string, CanonicalSupplierIdentityCandidate>();
  for (const candidate of candidates) {
    const id = typeof candidate.supplier_listing_id === "string" ? candidate.supplier_listing_id.trim() : "";
    if (id) byId.set(id, candidate);
  }
  const ids = [...byId.keys()];
  if (ids.length === 0) return new Set();

  const supabase = createSupabaseAdminClient();
  const linked = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await supabase
      .from("supplier_listings")
      .select("id,product_id,supplier_product_id,supplier_variant_id,identity_status")
      .in("id", batch);
    if (error) throw new Error(`supplier_identity_exact_lookup_failed:${error.message}`);

    for (const source of data ?? []) {
      const candidateGroup = byId.get(String(source.id));
      // A single supplier row must not validate multiple conflicting storefront
      // mappings. Any repeated supplier_listing_id is ambiguous and blocked.
      if (!candidateGroup || candidateGroup.length !== 1 || source.identity_status !== "linked") continue;
      const listing = candidateGroup[0];
      const canonicalProductId = typeof listing.product_id === "string" ? listing.product_id.trim() : "";
      const sourceProductId = typeof source.product_id === "string" ? source.product_id.trim() : "";
      const listingSupplierProductId = typeof listing.supplier_product_id === "string" ? listing.supplier_product_id.trim() : "";
      const sourceSupplierProductId = typeof source.supplier_product_id === "string" ? source.supplier_product_id.trim() : "";
      const listingVariantId = typeof listing.supplier_variant_id === "string" ? listing.supplier_variant_id.trim() : "";
      const sourceVariantId = typeof source.supplier_variant_id === "string" ? source.supplier_variant_id.trim() : "";
      if (
        canonicalProductId &&
        sourceProductId === canonicalProductId &&
        listingSupplierProductId &&
        sourceSupplierProductId === listingSupplierProductId &&
        listingVariantId &&
        sourceVariantId === listingVariantId
      ) linked.add(String(source.id));
    }
  }
  return linked;
}
