import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type SupplierPublicationIdentity = "linked" | "native_cj_verified";

/**
 * Standalone CJ supply is not a marketplace identity match. It may nevertheless
 * be published as its own catalog product when the exact CJ product+variant,
 * live Japan shipping, stock, price, API order path, and tracking are verified.
 */
export function isNativeCjSupplierListing(row: Record<string, unknown>, nowMs = Date.now()): boolean {
  const supplier = String(row.supplier ?? "").trim().toLowerCase();
  const verifiedAt = typeof row.last_verified_at === "string" ? Date.parse(row.last_verified_at) : NaN;
  const verificationError = row.verification_error;
  return ["cj", "cjdropshipping"].includes(supplier)
    && row.verification_status === "verified"
    && row.shipping_status === "verified"
    && row.configured === true
    && row.price_confirmed === true
    && row.inventory_confirmed === true
    && row.api_available === true
    && row.orderable === true
    && row.tracking_available === true
    && Number(row.inventory) > 0
    && Number(row.cost) > 0
    && Number(row.shipping_cost) >= 0
    && String(row.ship_to ?? "").trim().toUpperCase() === "JP"
    && Boolean(typeof row.supplier_product_id === "string" && row.supplier_product_id.trim())
    && Boolean(typeof row.supplier_variant_id === "string" && row.supplier_variant_id.trim())
    // Administrative workflow labels are not supplier identity evidence. Exact product/variant IDs
    // plus fresh verified Japan shipping, price, stock, API, orderability and tracking are authoritative.
    // A stale configuration error is contradictory only when this same row has
    // fresh verified JP shipping, exact variant IDs, and both configured/API flags true.
    // Do not let an old setup message permanently suppress an otherwise verified offer.
    && (verificationError == null || verificationError === "" || (verificationError === "CJdropshipping is not configured" && row.configured === true && row.api_available === true))
    && Number.isFinite(verifiedAt)
    && verifiedAt >= nowMs - 7 * 24 * 60 * 60 * 1000
    && verifiedAt <= nowMs + 5 * 60 * 1000;
}

/** Returns publication-safe supplier identity states; native CJ supply is kept distinct from canonical links. */
export type SupplierListingReference = {
  /** The shop_listings row that will be published or sold. */
  listingId: string;
  supplierListingId: string | null;
  productId: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
};

/**
 * Returns publication-safe supplier identity states keyed by shop listing ID.
 * A healthy supplier row is not sufficient by itself: its internal product ID,
 * external product ID, and exact variant ID must match this listing's snapshot.
 * This prevents a stale supplier_listing_id foreign key from making a different
 * product appear orderable or publishable.
 */
export async function getPublishableSupplierListingStatuses(
  references: SupplierListingReference[],
): Promise<Map<string, SupplierPublicationIdentity>> {
  const validReferences = references.filter((reference) =>
    Boolean(reference.listingId?.trim())
    && Boolean(reference.supplierListingId?.trim())
    && Boolean(reference.productId?.trim())
    && Boolean(reference.supplierProductId?.trim())
    && Boolean(reference.supplierVariantId?.trim()),
  );
  const ids = [...new Set(validReferences.map((reference) => reference.supplierListingId as string))];
  if (ids.length === 0) return new Map();

  const referencesBySupplierId = new Map<string, SupplierListingReference[]>();
  for (const reference of validReferences) {
    const supplierId = reference.supplierListingId as string;
    const group = referencesBySupplierId.get(supplierId) ?? [];
    group.push(reference);
    referencesBySupplierId.set(supplierId, group);
  }

  const supabase = createSupabaseAdminClient();
  const statuses = new Map<string, SupplierPublicationIdentity>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await supabase
      .from("supplier_listings")
      .select("id,product_id,supplier,identity_status,verification_status,shipping_status,configured,price_confirmed,inventory_confirmed,api_available,orderable,tracking_available,inventory,cost,shipping_cost,ship_to,supplier_product_id,supplier_variant_id,verification_error,last_verified_at")
      .in("id", batch);
    if (error) throw new Error(`supplier_publication_identity_lookup_failed:${error.message}`);
    for (const row of data ?? []) {
      const id = String(row.id);
      const exactReferences = (referencesBySupplierId.get(id) ?? []).filter((reference) =>
        String(row.product_id ?? "") === reference.productId
        && String(row.supplier_product_id ?? "") === reference.supplierProductId
        && String(row.supplier_variant_id ?? "") === reference.supplierVariantId,
      );
      if (exactReferences.length === 0) continue;
      let status: SupplierPublicationIdentity | null = null;
      if (row.identity_status === "linked") status = "linked";
      else if (isNativeCjSupplierListing(row as Record<string, unknown>)) status = "native_cj_verified";
      if (!status) continue;
      for (const reference of exactReferences) statuses.set(reference.listingId, status);
    }
  }
  return statuses;
}

/** Returns only supplier listings whose canonical marketplace identity review is explicitly linked. */
export async function getLinkedSupplierListingIds(values: unknown[]): Promise<Set<string>> {
  const ids = [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
  if (ids.length === 0) return new Set();

  const supabase = createSupabaseAdminClient();
  const linked = new Set<string>();
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
