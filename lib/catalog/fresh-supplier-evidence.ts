import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type SupplierEvidenceRef = {
  listingId: string;
  supplierListingId: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
};
export type SupplierEvidence = { inventory: number; supplierProductId: string; supplierVariantId: string };

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Fails closed unless the exact supplier variant has recently confirmed, verified stock. */
export async function getFreshSupplierEvidence(refs: SupplierEvidenceRef[], nowMs = Date.now()) {
  const valid = refs.filter((r) => r.supplierListingId && r.supplierProductId && r.supplierVariantId);
  const ids = [...new Set(valid.map((r) => r.supplierListingId as string))];
  const result = new Map<string, SupplierEvidence>();
  if (!ids.length) return result;
  const db = createSupabaseAdminClient();
  const rows = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from("supplier_listings")
      .select("id,supplier_product_id,supplier_variant_id,identity_status,verification_status,inventory_confirmed,inventory,inventory_checked_at,next_verification_at,orderable,api_available,tracking_available,price_confirmed,cost,shipping_cost")
      .in("id", ids.slice(i, i + 100));
    if (error) throw new Error(`fresh_supplier_evidence_lookup_failed:${error.message}`);
    for (const row of data ?? []) rows.set(String(row.id), row as Record<string, unknown>);
  }
  for (const ref of valid) {
    const row = rows.get(ref.supplierListingId as string);
    if (!row || row.identity_status !== "linked" || row.verification_status !== "verified" ||
      row.inventory_confirmed !== true || row.price_confirmed !== true || row.orderable !== true ||
      row.api_available !== true || row.tracking_available !== true) continue;
    const productId = String(row.supplier_product_id ?? "");
    const variantId = String(row.supplier_variant_id ?? "");
    if (productId !== ref.supplierProductId || variantId !== ref.supplierVariantId) continue;
    const inventory = Number(row.inventory);
    const cost = Number(row.cost);
    const shippingCost = Number(row.shipping_cost);
    if (!Number.isFinite(inventory) || inventory <= 0 || !Number.isFinite(cost) || cost <= 0 ||
      !Number.isFinite(shippingCost) || shippingCost < 0) continue;
    const checkedAt = typeof row.inventory_checked_at === "string" ? Date.parse(row.inventory_checked_at) : NaN;
    if (!Number.isFinite(checkedAt) || nowMs - checkedAt > MAX_AGE_MS || checkedAt > nowMs + 5 * 60 * 1000) continue;
    if (row.next_verification_at !== null && row.next_verification_at !== undefined) {
      const next = typeof row.next_verification_at === "string" ? Date.parse(row.next_verification_at) : NaN;
      if (!Number.isFinite(next) || next <= nowMs) continue;
    }
    result.set(ref.listingId, { inventory: Math.floor(inventory), supplierProductId: productId, supplierVariantId: variantId });
  }
  return result;
}
