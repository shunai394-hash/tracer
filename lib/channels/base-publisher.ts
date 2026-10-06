import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createBaseItem, editBaseItem, addBaseItemImage, isBaseConfigured } from "@/lib/channels/base";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";

export type BasePublicationResult = {
  attempted: number;
  published: number;
  skipped: number;
  failed: number;
  results: Array<{ listingId: string; ok: boolean; baseItemId?: string | null; skipped?: boolean; error?: string }>;
};

function validHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; } catch { return false; }
}

export async function publishPublishedListingsToBase(limit = 10, listingIds?: string[]): Promise<BasePublicationResult> {
  if (!isBaseConfigured()) return { attempted: 0, published: 0, skipped: 0, failed: 0, results: [] };
  if (listingIds !== undefined && listingIds.length === 0) return { attempted: 0, published: 0, skipped: 0, failed: 0, results: [] };
  const supabase = createSupabaseAdminClient();
  let query = supabase.from("shop_listings").select("id,title,description,selling_price,image_url,published,base_item_id,base_publication_status,base_publication_lease_until,inventory,orderable,shipping_cost,supplier_name,supplier_listing_id,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons").or("published.eq.true,base_item_id.not.is.null");
  if (listingIds && listingIds.length > 0) query = query.in("id", Array.from(new Set(listingIds)));
  const { data: listings, error } = await query.order("base_item_id", { ascending: true, nullsFirst: true }).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);

  const results: BasePublicationResult["results"] = [];
  for (const listing of listings ?? []) {
    const listingId = String(listing.id);
    const hasSalesTestGate = hasPassedSalesTestGate(listing);

    if (listing.base_item_id && listing.published !== true) {
      if (listing.selling_price === null) { results.push({ listingId, ok: false, skipped: true, error: "base_hide_price_unknown" }); continue; }
      try {
        await editBaseItem({ itemId: String(listing.base_item_id), title: listing.title, detail: listing.description ?? listing.title, price: Number(listing.selling_price), stock: 0, visible: false });
        await supabase.from("shop_listings").update({ base_publication_status: "published", base_publication_lease_until: null, base_last_error: null, pipeline_stage: "BASE_RECONCILED", pipeline_status: "blocked", pipeline_reason: "tracer_unpublished", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
        results.push({ listingId, ok: true, baseItemId: String(listing.base_item_id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
        results.push({ listingId, ok: false, error: message });
      }
      continue;
    }

    if (!listing.base_item_id && !hasSalesTestGate) { results.push({ listingId, ok: false, skipped: true, error: "sales_test_gate_not_passed" }); continue; }

    const autoProcurement = getAutoProcurementEligibility(typeof listing.supplier_name === "string" ? listing.supplier_name : null);
    if (!autoProcurement.eligible) {
      let baseSyncError: string | null = null;
      if (listing.base_item_id && listing.selling_price !== null) {
        try { await editBaseItem({ itemId: String(listing.base_item_id), title: listing.title, detail: listing.description ?? listing.title, price: Number(listing.selling_price), stock: 0, visible: false }); }
        catch (error) { baseSyncError = error instanceof Error ? error.message : String(error); }
      }
      const now = new Date().toISOString();
      const { error: blockError } = await supabase.from("shop_listings").update({ published: false, orderable: false, base_publication_lease_until: null, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "supplier_auto_procurement_capability_missing", pipeline_error: baseSyncError, pipeline_updated_at: now, updated_at: now }).eq("id", listingId);
      if (blockError) throw new Error(blockError.message);
      if (listing.supplier_listing_id) {
        const { error: supplierBlockError } = await supabase.from("supplier_listings").update({ orderable: false, verification_status: "retryable", verification_error: `supplier_auto_procurement_capability_missing:${autoProcurement.missing.join("|")}`, fetched_at: now }).eq("id", String(listing.supplier_listing_id));
        if (supplierBlockError) throw new Error(supplierBlockError.message);
      }
      results.push({ listingId, ok: false, skipped: true, error: baseSyncError ? `supplier_auto_procurement_capability_missing:${autoProcurement.missing.join("|")}:base_hide_failed:${baseSyncError}` : `supplier_auto_procurement_capability_missing:${autoProcurement.missing.join("|")}` });
      continue;
    }

    const price = Number(listing.selling_price);
    if (!Number.isFinite(price) || price <= 0) {
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "selling_price_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "selling_price_invalid" });
      continue;
    }

    if (!validHttpUrl(listing.image_url)) {
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "image_url_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "image_url_invalid" });
      continue;
    }

    const shippingCost = listing.shipping_cost === null || listing.shipping_cost === undefined ? null : Number(listing.shipping_cost);
    if (shippingCost === null || !Number.isFinite(shippingCost) || shippingCost <= 0) {
      if (listing.base_item_id) {
        try { await editBaseItem({ itemId: String(listing.base_item_id), title: listing.title, detail: listing.description ?? listing.title, price, stock: 0, visible: false }); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_shipping_unknown_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message }); continue;
        }
      }
      await supabase.from("shop_listings").update({ published: false, base_publication_status: listing.base_item_id ? "published" : "blocked", base_publication_lease_until: null, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: shippingCost === null ? "shipping_unknown" : "shipping_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: shippingCost === null ? "shipping_unknown" : "shipping_invalid" }); continue;
    }

    const availableInventory = typeof listing.inventory === "number" ? Math.floor(listing.inventory) : typeof listing.inventory === "string" && listing.inventory.trim() !== "" ? Math.floor(Number(listing.inventory)) : null;
    if (availableInventory === null || !Number.isFinite(availableInventory) || availableInventory <= 0 || listing.orderable !== true) {
      if (listing.base_item_id) {
        try { await editBaseItem({ itemId: String(listing.base_item_id), title: listing.title, detail: listing.description ?? listing.title, price, stock: 0, visible: false }); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message }); continue;
        }
      }
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: availableInventory === null || !Number.isFinite(availableInventory) ? "inventory_unknown" : availableInventory <= 0 ? "inventory_zero" : "supplier_not_orderable", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: availableInventory === null || !Number.isFinite(availableInventory) ? "inventory_unknown" : availableInventory <= 0 ? "inventory_zero" : "supplier_not_orderable" }); continue;
    }

    const leaseUntil = new Date(Date.now() + 2 * 60_000).toISOString();
    try {
      let baseItemId = listing.base_item_id ? String(listing.base_item_id) : null;
      if (baseItemId) {
        await editBaseItem({ itemId: baseItemId, title: listing.title, detail: listing.description ?? listing.title, price, stock: availableInventory, visible: true });
      } else {
        const created = await createBaseItem({ title: listing.title, detail: listing.description ?? listing.title, price, stock: availableInventory, visible: true });
        baseItemId = String(created.id);
      }
      if (listing.image_url) await addBaseItemImage({ itemId: baseItemId, imageUrl: listing.image_url });
      await supabase.from("shop_listings").update({ base_item_id: baseItemId, base_publication_status: "published", base_publication_lease_until: leaseUntil, base_last_error: null, pipeline_stage: "BASE_PUBLISHED", pipeline_status: "published", pipeline_reason: "sales_test_gate_passed", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: true, baseItemId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "failed", pipeline_reason: "base_publish_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, error: message });
    }
  }
  return { attempted: listings?.length ?? 0, published: results.filter((r) => r.ok && r.baseItemId).length, skipped: results.filter((r) => r.skipped).length, failed: results.filter((r) => !r.ok && !r.skipped).length, results };
}
