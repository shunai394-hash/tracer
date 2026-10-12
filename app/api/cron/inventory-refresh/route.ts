import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem, isBaseConfigured } from "@/lib/channels/base";
import { isSupplierConfigured } from "@/lib/config/env";
import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
import { hasDurableSalesTestGate } from "@/lib/suppliers/inventory-refresh-gate";
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
      .select("id, supplier_listing_id, supplier_name, supplier_product_id, supplier_variant_id, base_item_id, title, description, selling_price, source_cost, shipping_cost, contribution_profit, contribution_margin, selection_reasons, pipeline_stage, pipeline_status, pipeline_reason")
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
      .select("id, supplier_listing_id, supplier_name, supplier_product_id, supplier_variant_id, base_item_id, title, description, selling_price, source_cost, shipping_cost, contribution_profit, contribution_margin, selection_reasons, pipeline_stage, pipeline_status, pipeline_reason")
      .not("supplier_name", "is", null)
      .not("supplier_variant_id", "is", null)
      .eq("published", true)
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
              inventory: null,
              orderable: false,
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

        // A stock quantity alone is not enough to authorize a listing. Refresh
        // price and Japan shipping from the same exact supplier variant.
        const [priceResult, shippingResult] = await Promise.all([
          adapter.getPrice(String(listing.supplier_product_id ?? ""), variantId),
          adapter.getShipping(String(listing.supplier_product_id ?? ""), variantId, {
            destinationCountryCode: "JP",
            quantity: 1,
          }),
        ]);
        const evidenceMatches =
          Boolean(listing.supplier_listing_id) &&
          inventoryResult !== null &&
          priceResult !== null &&
          shippingResult !== null &&
          inventoryResult.supplierProductId === String(listing.supplier_product_id ?? "") &&
          inventoryResult.supplierVariantId === variantId &&
          Number.isInteger(inventoryResult.quantity) &&
          inventoryResult.quantity !== null &&
          inventoryResult.quantity > 0 &&
          inventoryResult.available === true &&
          inventory === inventoryResult.quantity &&
          priceResult.supplierProductId === String(listing.supplier_product_id ?? "") &&
          priceResult.supplierVariantId === variantId &&
          shippingResult.supplierProductId === String(listing.supplier_product_id ?? "") &&
          shippingResult.supplierVariantId === variantId &&
          typeof priceResult.amount === "number" &&
          Number.isFinite(priceResult.amount) &&
          priceResult.amount >= 0 &&
          typeof shippingResult.amount === "number" &&
          Number.isFinite(shippingResult.amount) &&
          shippingResult.amount >= 0 &&
          // shop_listings selling/source/shipping costs are stored as JPY.
          // Never persist a supplier-native USD/EUR amount into those JPY fields.
          priceResult.currency?.trim().toUpperCase() === "JPY" &&
          shippingResult.currency?.trim().toUpperCase() === "JPY" &&
          priceResult.currency.trim().toUpperCase() === shippingResult.currency.trim().toUpperCase() &&
          shippingResult.available === true;
        if (!evidenceMatches) {
          const reason = "fresh_supplier_variant_price_or_japan_shipping_unverified";
          const { error: blockError } = await supabase
            .from("shop_listings")
            .update({
              published: false,
              orderable: false,
              contribution_profit: null,
              contribution_margin: null,
              selection_reasons: Array.isArray(listing.selection_reasons)
                ? listing.selection_reasons.map((item: unknown) => String(item)).filter((item: string) => item !== SALES_TEST_GATE_PASSED)
                : [],
              pipeline_stage: "BLOCKED",
              pipeline_status: "blocked",
              pipeline_reason: reason,
              pipeline_error: reason,
              pipeline_updated_at: now,
              updated_at: now,
            })
            .eq("id", listingId);
          if (blockError) throw new Error(blockError.message);
          if (listing.supplier_listing_id) {
            const { error: supplierError } = await supabase
              .from("supplier_listings")
              .update({ orderable: false, price_confirmed: false, inventory_confirmed: false, fetched_at: now })
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
              await supabase.from("shop_listings").update({ base_last_error: baseSyncError }).eq("id", listingId);
            }
          }
          results.push({ listingId, ok: false, blocked: true, reason, baseSyncError });
          continue;
        }

        const { error: supplierEvidenceError } = await supabase
          .from("supplier_listings")
          .update({
            inventory,
            inventory_checked_at: now,
            inventory_confirmed: true,
            cost: priceResult.amount,
            price_confirmed: true,
            price_checked_at: now,
            shipping_cost: shippingResult.amount,
            shipping_checked_at: now,
            fetched_at: now,
          })
          .eq("id", String(listing.supplier_listing_id ?? ""));
        if (supplierEvidenceError) throw new Error(supplierEvidenceError.message);

        // Fresh supplier costs invalidate prior profitability decisions when the
        // landed-cost inputs change. Do not silently reuse a previously passed
        // Sales Test Gate or re-enable the BASE item with stale margins.
        const verifiedPrice = Number(priceResult.amount);
        const verifiedShipping = Number(shippingResult.amount);
        const priorSourceCost = listing.source_cost === null || listing.source_cost === undefined ? null : Number(listing.source_cost);
        const priorShippingCost = listing.shipping_cost === null || listing.shipping_cost === undefined ? null : Number(listing.shipping_cost);
        const economicsChanged =
          priorSourceCost === null ||
          !Number.isFinite(priorSourceCost) ||
          Math.abs(priorSourceCost - verifiedPrice) >= 0.01 ||
          priorShippingCost === null ||
          !Number.isFinite(priorShippingCost) ||
          Math.abs(priorShippingCost - verifiedShipping) >= 0.01;

        if (economicsChanged) {
          const previousReasons = Array.isArray(listing.selection_reasons)
            ? listing.selection_reasons.map((reason: unknown) => String(reason))
            : [];
          const invalidatedReasons = previousReasons.filter((reason: string) => reason !== SALES_TEST_GATE_PASSED);
          const reason = "supplier_cost_changed_profitability_retest_required";
          const { error: invalidateError } = await supabase
            .from("shop_listings")
            .update({
              source_cost: priceResult.amount,
              shipping_cost: shippingResult.amount,
              contribution_profit: null,
              contribution_margin: null,
              selection_reasons: invalidatedReasons,
              published: false,
              orderable: false,
              pipeline_stage: "BLOCKED",
              pipeline_status: "blocked",
              pipeline_reason: reason,
              pipeline_error: reason,
              pipeline_updated_at: now,
              updated_at: now,
            })
            .eq("id", listingId);
          if (invalidateError) throw new Error(invalidateError.message);

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
              const { error: baseErrorUpdate } = await supabase
                .from("shop_listings")
                .update({ base_last_error: baseSyncError })
                .eq("id", listingId);
              if (baseErrorUpdate) throw new Error(baseErrorUpdate.message);
            }
          }
          results.push({ listingId, ok: false, blocked: true, reason, baseSyncError });
          continue;
        }

        // A refreshed stock count cannot restore saleability after a cost change
        // invalidated the profitability gate. Only the selection pipeline may
        // re-establish this durable marker after re-running the Sales Test Gate.
        if (!hasDurableSalesTestGate(listing.selection_reasons)) {
          const reason = "sales_test_gate_not_passed";
          const { error: blockError } = await supabase
            .from("shop_listings")
            .update({
              published: false,
              orderable: false,
              contribution_profit: null,
              contribution_margin: null,
              pipeline_stage: "BLOCKED",
              pipeline_status: "blocked",
              pipeline_reason: reason,
              pipeline_error: reason,
              pipeline_updated_at: now,
              updated_at: now,
            })
            .eq("id", listingId);
          if (blockError) throw new Error(blockError.message);

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
              const { error: baseErrorUpdate } = await supabase
                .from("shop_listings")
                .update({ base_last_error: baseSyncError })
                .eq("id", listingId);
              if (baseErrorUpdate) throw new Error(baseErrorUpdate.message);
            }
          }
          results.push({ listingId, ok: false, blocked: true, reason, baseSyncError });
          continue;
        }

        const orderable = inventory > 0;
        const { error: listingError } = await supabase
          .from("shop_listings")
          .update({
            inventory,
            source_cost: priceResult.amount,
            shipping_cost: shippingResult.amount,
            orderable,
            updated_at: now,
          })
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
              visible: orderable,
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
