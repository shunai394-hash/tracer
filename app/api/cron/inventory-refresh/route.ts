import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem, isBaseConfigured } from "@/lib/channels/base";
import { isSupplierConfigured } from "@/lib/config/env";
import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { requireAutomationAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    initializeProcurement();
    const supabase = createSupabaseAdminClient();
    const { data: listings, error } = await supabase
      .from("shop_listings")
      .select("id, supplier_listing_id, supplier_name, supplier_product_id, supplier_variant_id, base_item_id, title, description, selling_price, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, published")
      .not("supplier_name", "is", null)
      .not("supplier_variant_id", "is", null)
      .or("base_item_id.not.is.null,and(pipeline_stage.eq.PUBLISHED,pipeline_status.eq.published,pipeline_reason.eq.sales_test_gate_passed)")
      .order("updated_at", { ascending: true })
      .limit(20);

    if (error) throw new Error(error.message);

    // Gate-passed listings whose pipeline_* moved on (e.g. temporarily
    // blocked for zero stock) must keep being refreshed, or they could never
    // become orderable again. selection_reasons carries the durable marker.
    const { data: gatedListings, error: gatedError } = await supabase
      .from("shop_listings")
      .select("id, supplier_listing_id, supplier_name, supplier_product_id, supplier_variant_id, base_item_id, title, description, selling_price, pipeline_stage, pipeline_status, pipeline_reason, selection_reasons, published")
      .not("supplier_name", "is", null)
      .not("supplier_variant_id", "is", null)
      .filter("selection_reasons", "cs", JSON.stringify([SALES_TEST_GATE_PASSED]))
      .order("updated_at", { ascending: true })
      .limit(20);
    if (gatedError) throw new Error(gatedError.message);

    const seen = new Set<string>();
    const refreshTargets = [...(listings ?? []), ...(gatedListings ?? [])].filter((row) => {
      const id = String(row.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const results = [];
    let baseUpdated = 0;
    let baseErrors = 0;
    for (const listing of refreshTargets) {
      const listingId = String(listing.id);
      const supplierName = String(listing.supplier_name ?? "").trim();
      const variantId = String(listing.supplier_variant_id);
      const adapter = getSupplierAdapter(supplierName);
      try {
        if (!supplierName || !adapter) {
          results.push({ listingId, ok: false, blocked: true, reason: "supplier_adapter_not_registered" });
          continue;
        }
        if (!isSupplierConfigured(supplierName)) {
          results.push({ listingId, ok: false, blocked: true, reason: "supplier_not_configured", supplier: supplierName });
          continue;
        }

        const autoProcurement = getAutoProcurementEligibility(supplierName);
        if (!autoProcurement.eligible) {
          const now = new Date().toISOString();
          const { error: blockError } = await supabase
            .from("shop_listings")
            .update({
              published: false,
              orderable: false,
              pipeline_error: autoProcurement.missing.join("|"),
              pipeline_updated_at: now,
              updated_at: now,
            })
            .eq("id", listingId);
          if (blockError) throw new Error(blockError.message);

          if (listing.supplier_listing_id) {
            const { error: supplierError } = await supabase
              .from("supplier_listings")
              .update({
                orderable: false,
                fetched_at: now,
              })
              .eq("id", String(listing.supplier_listing_id));
            if (supplierError) throw new Error(supplierError.message);
          }

          let baseSyncError: string | null = null;
          if (listing.base_item_id && listing.selling_price !== null && isBaseConfigured()) {
            try {
              await editBaseItem({
                itemId: String(listing.base_item_id),
                title: String(listing.title ?? ""),
                detail: String(listing.description ?? listing.title ?? ""),
                price: Number(listing.selling_price),
                stock: 0,
                visible: false,
              });
              baseUpdated++;
            } catch (error) {
              baseSyncError = error instanceof Error ? error.message : String(error);
              baseErrors++;
              await supabase.from("shop_listings").update({
                base_last_error: baseSyncError,
              }).eq("id", listingId);
            }
          }

          results.push({
            listingId,
            ok: false,
            blocked: true,
            reason: "supplier_auto_procurement_capability_missing",
            missing: autoProcurement.missing,
            baseSyncError,
          });
          continue;
        }
        if (supplierName.toLowerCase() === "dsers") {
          results.push({ listingId, ok: false, blocked: true, reason: "supplier_inventory_contract_unverified", supplier: supplierName });
          continue;
        }
        const inventoryResult = await adapter.getInventory(
          String(listing.supplier_product_id ?? ""),
          variantId,
        );
        const inventory = inventoryResult?.quantity ?? null;
        const now = new Date().toISOString();

        if (inventory === null) {
          const { error: listingError } = await supabase
            .from("shop_listings")
            .update({
              published: false,
              inventory: null,
              orderable: false,
              pipeline_status: "blocked",
              pipeline_reason: "inventory_unknown",
              pipeline_error: "Supplier variant stock could not be verified",
              pipeline_updated_at: now,
              updated_at: now,
            })
            .eq("id", listingId);
          if (listingError) throw new Error(listingError.message);

          if (listing.supplier_listing_id) {
            const { error: supplierError } = await supabase
              .from("supplier_listings")
              .update({
                inventory: null,
                inventory_confirmed: false,
                orderable: false,
                fetched_at: now,
              })
              .eq("id", String(listing.supplier_listing_id));
            if (supplierError) throw new Error(supplierError.message);
          }

          let baseSyncError: string | null = null;
          if (listing.base_item_id && listing.selling_price !== null && isBaseConfigured()) {
            try {
              await editBaseItem({
                itemId: String(listing.base_item_id),
                title: String(listing.title ?? ""),
                detail: String(listing.description ?? listing.title ?? ""),
                price: Number(listing.selling_price),
                stock: 0,
                visible: false,
              });
              baseUpdated++;
              await supabase.from("shop_listings").update({
                base_last_error: null,
              }).eq("id", listingId);
            } catch (error) {
              baseSyncError = error instanceof Error ? error.message : String(error);
              baseErrors++;
              await supabase.from("shop_listings").update({
                base_last_error: baseSyncError,
              }).eq("id", listingId);
            }
          }

          results.push({ listingId, ok: false, blocked: true, reason: "inventory_unknown", baseSyncError });
          continue;
        }

        const orderable = inventory > 0;
        const hasSalesTestGate = Array.isArray(listing.selection_reasons)
          && listing.selection_reasons.includes(SALES_TEST_GATE_PASSED);
        const recoveringFromInventoryBlock = hasSalesTestGate
          && (listing.pipeline_reason === "inventory_unknown" || listing.pipeline_reason === "inventory_zero");
        const listingPatch: Record<string, unknown> = {
          inventory,
          orderable,
          updated_at: now,
        };
        if (!orderable) {
          listingPatch.published = false;
          listingPatch.pipeline_status = "blocked";
          listingPatch.pipeline_reason = "inventory_zero";
          listingPatch.pipeline_error = "Supplier variant inventory is zero";
        } else if (recoveringFromInventoryBlock) {
          // Restore only listings carrying the durable sales-test proof and
          // blocked specifically by this inventory refresher; do not revive
          // manually or otherwise unpublished listings.
          listingPatch.published = true;
          listingPatch.pipeline_stage = "PUBLISHED";
          listingPatch.pipeline_status = "published";
          listingPatch.pipeline_reason = SALES_TEST_GATE_PASSED;
          listingPatch.pipeline_error = null;
        }
        const { error: listingError } = await supabase
          .from("shop_listings")
          .update(listingPatch)
          .eq("id", listingId)
          .eq("id", listingId);
        if (listingError) throw new Error(listingError.message);

        if (listing.supplier_listing_id) {
          const { error: supplierError } = await supabase
            .from("supplier_listings")
            .update({
              inventory,
              inventory_confirmed: true,
              orderable,
              fetched_at: now,
            })
            .eq("id", String(listing.supplier_listing_id));
          if (supplierError) throw new Error(supplierError.message);
        }

        let baseSyncError: string | null = null;
        if (listing.base_item_id && listing.selling_price !== null && isBaseConfigured()) {
          try {
            await editBaseItem({
              itemId: String(listing.base_item_id),
              title: String(listing.title ?? ""),
              detail: String(listing.description ?? listing.title ?? ""),
              price: Number(listing.selling_price),
              stock: orderable ? Math.max(0, Math.floor(inventory)) : 0,
              visible: orderable && (listing.published === true || recoveringFromInventoryBlock),
            });
            baseUpdated++;
            await supabase.from("shop_listings").update({
              base_last_error: null,
            }).eq("id", listingId);
          } catch (error) {
            baseSyncError = error instanceof Error ? error.message : String(error);
            baseErrors++;
            await supabase.from("shop_listings").update({
              base_last_error: baseSyncError,
            }).eq("id", listingId);
          }
        }

        results.push({ listingId, ok: true, inventory, orderable, baseSyncError });
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
      configured: (listings ?? []).length > 0,
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
