import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem, isBaseConfigured } from "@/lib/channels/base";
import { isSupplierConfigured } from "@/lib/config/env";
import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { decideInventoryRefresh, isInventoryRefreshTarget, type InventoryObservation } from "@/lib/ops/inventory-refresh-policy";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    initializeProcurement();
    const supabase = createSupabaseAdminClient();
    // Only published, gate-passed listings are refreshed. A BASE item id alone
    // (e.g. an unpublished or withdrawn listing) never makes a row a target.
    const { data: gatedListings, error } = await supabase
      .from("shop_listings")
      .select("id, published, selection_reasons, supplier_listing_id, supplier_name, supplier_product_id, supplier_variant_id, base_item_id, title, description, selling_price, pipeline_stage, pipeline_status, pipeline_reason")
      .not("supplier_name", "is", null)
      .not("supplier_variant_id", "is", null)
      .eq("published", true)
      .filter("selection_reasons", "cs", JSON.stringify([SALES_TEST_GATE_PASSED]))
      .order("updated_at", { ascending: true })
      .limit(40);
    if (error) throw new Error(error.message);
    const refreshTargets = (gatedListings ?? []).filter((row) => isInventoryRefreshTarget(row));

    const results = [];
    let baseUpdated = 0;
    let baseErrors = 0;
    async function syncBase(listing: Record<string, unknown>, listingId: string, stock: number, visible: boolean): Promise<string | null> {
      if (!listing.base_item_id || listing.selling_price === null || !isBaseConfigured()) return null;
      try {
        await editBaseItem({
          itemId: String(listing.base_item_id),
          title: String(listing.title ?? ""),
          detail: String(listing.description ?? listing.title ?? ""),
          price: Number(listing.selling_price),
          stock,
          visible,
        });
        baseUpdated++;
        await supabase.from("shop_listings").update({ base_last_error: null }).eq("id", listingId);
        return null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        baseErrors++;
        await supabase.from("shop_listings").update({ base_last_error: message }).eq("id", listingId);
        return message;
      }
    }

    for (const listing of refreshTargets) {
      const listingId = String(listing.id);
      const supplierName = String(listing.supplier_name ?? "").trim();
      const variantId = String(listing.supplier_variant_id);
      const adapter = getSupplierAdapter(supplierName);
      try {
        // A supplier that can no longer be auto-procured is withdrawn from sale.
        if (supplierName && adapter && isSupplierConfigured(supplierName)) {
          const autoProcurement = getAutoProcurementEligibility(supplierName);
          if (!autoProcurement.eligible) {
            const now = new Date().toISOString();
            const { error: blockError } = await supabase
              .from("shop_listings")
              .update({ published: false, orderable: false, pipeline_error: autoProcurement.missing.join("|"), pipeline_updated_at: now, updated_at: now })
              .eq("id", listingId);
            if (blockError) throw new Error(blockError.message);
            if (listing.supplier_listing_id) {
              const { error: supplierError } = await supabase.from("supplier_listings").update({ orderable: false, fetched_at: now }).eq("id", String(listing.supplier_listing_id));
              if (supplierError) throw new Error(supplierError.message);
            }
            const baseSyncError = await syncBase(listing, listingId, 0, false);
            results.push({ listingId, ok: false, blocked: true, reason: "supplier_auto_procurement_capability_missing", missing: autoProcurement.missing, baseSyncError });
            continue;
          }
        }

        // Every path that cannot observe live stock stops the sale (safe side).
        let observation: InventoryObservation;
        if (!supplierName || !adapter) observation = { kind: "unavailable", reason: "supplier_adapter_not_registered" };
        else if (!isSupplierConfigured(supplierName)) observation = { kind: "unavailable", reason: "supplier_not_configured" };
        else if (supplierName.toLowerCase() === "dsers") observation = { kind: "unavailable", reason: "supplier_inventory_contract_unverified" };
        else {
          try {
            const inventoryResult = await adapter.getInventory(String(listing.supplier_product_id ?? ""), variantId);
            const quantity = inventoryResult?.quantity;
            observation = typeof quantity === "number"
              ? { kind: "observed", quantity }
              : { kind: "unavailable", reason: "inventory_unknown" };
          } catch (error) {
            observation = { kind: "unavailable", reason: `inventory_lookup_failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) };
          }
        }

        const decision = decideInventoryRefresh(observation);
        const now = new Date().toISOString();
        const { error: listingError } = await supabase
          .from("shop_listings")
          .update({
            inventory: decision.inventory,
            orderable: decision.orderable,
            ...(decision.stopSale ? { pipeline_error: decision.reason, pipeline_updated_at: now } : {}),
            updated_at: now,
          })
          .eq("id", listingId);
        if (listingError) throw new Error(listingError.message);

        if (listing.supplier_listing_id) {
          const { error: supplierError } = await supabase
            .from("supplier_listings")
            .update({ inventory: decision.inventory, inventory_confirmed: decision.inventoryConfirmed, orderable: decision.orderable, fetched_at: now })
            .eq("id", String(listing.supplier_listing_id));
          if (supplierError) throw new Error(supplierError.message);
        }

        const baseSyncError = await syncBase(listing, listingId, decision.baseStock, decision.baseVisible);
        results.push(decision.stopSale
          ? { listingId, ok: false, blocked: true, reason: decision.reason, inventory: decision.inventory, orderable: false, baseSyncError }
          : { listingId, ok: true, inventory: decision.inventory, orderable: true, baseSyncError });
      } catch (error) {
        results.push({
          listingId,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      configured: refreshTargets.length > 0,
      inspected: results.length,
      updated: results.filter((item) => item.ok).length,
      blocked: results.filter((item) => item.blocked).length,
      errors: results.filter((item) => !item.ok && !item.blocked).length,
      baseUpdated,
      baseErrors,
      results,
    });
  } catch (error) {
    console.error("[TRACER INVENTORY REFRESH CRON ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
