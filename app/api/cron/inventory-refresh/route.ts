import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { editBaseItem, isBaseConfigured } from "@/lib/channels/base";
import { isSupplierConfigured } from "@/lib/config/env";
import { initializeProcurement } from "@/lib/procurement/init";
import { getSupplierAdapter } from "@/lib/procurement/registry";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { evaluateShopListingRecord } from "@/lib/market/listing-commercial-gate";
import { attachSupplierCommercialEvidence } from "@/lib/market/supplier-commercial-evidence";
import { isShopifyConfigured, toShopifyGid, unpublishShopifyProduct } from "@/lib/shopify/admin";
import { probeListingImage } from "@/lib/market/probe-listing-image";
import { mayRestoreChannelVisibility, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";
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
      .select("id, supplier_listing_id, supplier_name, supplier_product_id, supplier_variant_id, base_item_id, shopify_product_id, title, description, image_url, selling_price, currency, source_cost, shipping_cost, contribution_profit, identity_method, identity_confidence, tracking_available, published, selection_reasons, pipeline_stage, pipeline_status, pipeline_reason")
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
      .select("id, supplier_listing_id, supplier_name, supplier_product_id, supplier_variant_id, base_item_id, shopify_product_id, title, description, image_url, selling_price, currency, source_cost, shipping_cost, contribution_profit, identity_method, identity_confidence, tracking_available, published, selection_reasons, pipeline_stage, pipeline_status, pipeline_reason")
      .not("supplier_name", "is", null)
      .not("supplier_variant_id", "is", null)
      // Include previously published items whose published flag was cleared by
      // a safety hold. mayRestoreChannelVisibility requires the durable Sales
      // Test token and an inventory-only pipeline reason before it can reopen.
      .filter("selection_reasons", "cs", JSON.stringify([SALES_TEST_GATE_PASSED]))
      .order("updated_at", { ascending: true })
      .limit(20);
    if (gatedError) throw new Error(gatedError.message);

    const seen = new Set<string>();
    const refreshTargets = await attachSupplierCommercialEvidence(supabase, [...(listings ?? []), ...(gatedListings ?? [])].filter((row) => {
      const id = String(row.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }));

    const results = [];
    let baseUpdated = 0;
    let baseErrors = 0;
    let baseSyncSkipped = 0;
    let shopifyStopped = 0;
    let shopifyStopErrors = 0;
    let shopifyStopSkipped = 0;
    async function stopShopifyListing(productId: unknown): Promise<string | null> {
      const id = typeof productId === "string" ? productId.trim() : "";
      if (!id) return null;
      if (!isShopifyConfigured()) {
        shopifyStopSkipped += 1;
        return "shopify_not_configured";
      }
      try {
        const gid = toShopifyGid("Product", id);
        if (!gid) {
          shopifyStopErrors += 1;
          return "shopify_product_id_invalid";
        }
        await unpublishShopifyProduct(gid);
        shopifyStopped += 1;
        return null;
      } catch (error) {
        shopifyStopErrors += 1;
        return error instanceof Error ? error.message : String(error);
      }
    }

    async function blockUnverifiedSupplierListing(listing: (typeof refreshTargets)[number], reason: string) {
      const now = new Date().toISOString();
      const { error: listingError } = await supabase.from("shop_listings").update({
        inventory: null,
        orderable: false,
        published: false,
        pipeline_stage: "BLOCKED",
        pipeline_status: "blocked",
        // Treat unverified supply as an inventory hold; recovery still requires
        // the durable Sales Test token and a fresh passing commercial gate.
        pipeline_reason: "inventory_unknown",
        pipeline_error: reason,
        pipeline_updated_at: now,
        updated_at: now,
      }).eq("id", String(listing.id));
      if (listingError) throw new Error(listingError.message);

      if (listing.supplier_listing_id) {
        const { error: supplierError } = await supabase.from("supplier_listings").update({
          inventory: null,
          inventory_confirmed: false,
          orderable: false,
          fetched_at: now,
        }).eq("id", String(listing.supplier_listing_id));
        if (supplierError) throw new Error(supplierError.message);
      }

      let baseSyncError: string | null = null;
      if (listing.base_item_id) {
        const price = Number(listing.selling_price);
        if (!isBaseConfigured()) {
          baseSyncSkipped++;
          baseSyncError = "base_not_configured";
        } else if (listing.selling_price === null || !Number.isFinite(price) || price <= 0) {
          baseSyncSkipped++;
          baseSyncError = "base_price_unknown";
        } else {
          try {
            await editBaseItem({
              itemId: String(listing.base_item_id),
              title: String(listing.title ?? "販売停止中の商品"),
              detail: "仕入先の在庫・発注可否を確認できないため、現在販売を停止しています。",
              price,
              stock: 0,
              visible: false,
            });
            baseUpdated++;
          } catch (error) {
            baseErrors++;
            baseSyncError = error instanceof Error ? error.message : String(error);
          }
        }
        const { error: baseStateError } = await supabase.from("shop_listings").update({
          base_last_error: baseSyncError,
        }).eq("id", String(listing.id));
        if (baseStateError) throw new Error(`base_reconciliation_state_write_failed:${baseStateError.message}`);
      }

      const shopifySyncError = await stopShopifyListing(listing.shopify_product_id);
      if (String(listing.shopify_product_id ?? "").trim()) {
        const { error: shopifyStateError } = await supabase.from("shop_listings").update({
          shopify_sync_status: shopifySyncError ? "reconciliation_required" : "blocked",
          shopify_sync_error: shopifySyncError
            ? `inventory_refresh_unpublish_failed:${shopifySyncError}`.slice(0, 500)
            : reason.slice(0, 500),
          shopify_synced_at: now,
        }).eq("id", String(listing.id));
        if (shopifyStateError) throw new Error(`shopify_reconciliation_state_write_failed:${shopifyStateError.message}`);
      }
      return { baseSyncError, shopifySyncError };
    }

    for (const listing of refreshTargets) {
      const listingId = String(listing.id);
      const supplierName = String(listing.supplier_name ?? "").trim();
      const variantId = String(listing.supplier_variant_id);
      const adapter = getSupplierAdapter(supplierName);
      try {
        if (!supplierName || !adapter) {
          const stopped = await blockUnverifiedSupplierListing(listing, "supplier_adapter_not_registered");
          results.push({ listingId, ok: false, blocked: true, reason: "supplier_adapter_not_registered", ...stopped });
          continue;
        }
        if (!isSupplierConfigured(supplierName)) {
          const stopped = await blockUnverifiedSupplierListing(listing, "supplier_not_configured");
          results.push({ listingId, ok: false, blocked: true, reason: "supplier_not_configured", supplier: supplierName, ...stopped });
          continue;
        }

        const autoProcurement = getAutoProcurementEligibility(supplierName);
        if (!autoProcurement.eligible) {
          const reason = "supplier_auto_procurement_capability_missing";
          const stopped = await blockUnverifiedSupplierListing(listing, reason);
          results.push({
            listingId,
            ok: false,
            blocked: true,
            reason,
            missing: autoProcurement.missing,
            ...stopped,
          });
          continue;
        }
        if (supplierName.toLowerCase() === "dsers") {
          const reason = "supplier_inventory_contract_unverified";
          const stopped = await blockUnverifiedSupplierListing(listing, reason);
          results.push({ listingId, ok: false, blocked: true, reason, supplier: supplierName, ...stopped });
          continue;
        }
        const inventoryResult = await adapter.getInventory(
          String(listing.supplier_product_id ?? ""),
          variantId,
        );
        const inventory = inventoryResult?.quantity ?? null;
        const now = new Date().toISOString();

        if (inventory === null) {
          const reason = "inventory_unknown";
          const stopped = await blockUnverifiedSupplierListing(listing, reason);
          results.push({ listingId, ok: false, blocked: true, reason, ...stopped });
          continue;
        }

        const imageReachable = await probeListingImage(listing.image_url);
        const refreshDecision = evaluateShopListingRecord(listing as unknown as Record<string, unknown>, imageReachable, {
          inventory,
          inventoryConfirmed: true,
          orderable: inventory > 0,
          salesTestPassed: mayRestoreChannelVisibility(listing),
          supplierAdapterRegistered: true,
        });
        const orderable = refreshDecision.eligible;
        const showOnBase = refreshDecision.eligible;
        // Persist the canonical gate result with the refreshed stock before
        // syncing either channel. Without this, a rejected outlier could remain
        // published=true in TRACER while BASE/Shopify were being stopped.
        const { error: listingError } = await supabase
          .from("shop_listings")
          .update({
            inventory,
            orderable,
            published: orderable,
            pipeline_stage: orderable ? "PUBLISHED" : "BLOCKED",
            pipeline_status: orderable ? "published" : "blocked",
            pipeline_reason: orderable
              ? SALES_TEST_GATE_PASSED
              : refreshDecision.reasons[0] ?? "listing_gate_not_passed",
            pipeline_updated_at: now,
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
              stock: showOnBase ? Math.max(0, Math.floor(inventory)) : 0,
              visible: showOnBase,
            });
            baseUpdated++;
            const { error: clearBaseError } = await supabase.from("shop_listings").update({
              base_last_error: null,
            }).eq("id", listingId);
            if (clearBaseError) throw new Error(clearBaseError.message);
          } catch (error) {
            baseSyncError = error instanceof Error ? error.message : String(error);
            baseErrors++;
            await supabase.from("shop_listings").update({
              base_last_error: baseSyncError,
            }).eq("id", listingId);
          }
        } else if (listing.base_item_id) {
          // Never report the refresh as clean if an existing external item
          // could not be reconciled because credentials or a valid price are absent.
          baseSyncSkipped++;
          baseSyncError = !isBaseConfigured() ? "base_not_configured" : "base_price_unknown";
          await supabase.from("shop_listings").update({
            base_last_error: baseSyncError,
          }).eq("id", listingId);
        }

        const shopifySyncError = showOnBase ? null : await stopShopifyListing(listing.shopify_product_id);
        if (!showOnBase) {
          const { error: shopifyStateError } = await supabase.from("shop_listings").update({
            shopify_sync_status: shopifySyncError ? "reconciliation_required" : "blocked",
            shopify_sync_error: shopifySyncError
              ? `inventory_refresh_unpublish_failed:${shopifySyncError}`.slice(0, 500)
              : refreshDecision.reasons.join(",").slice(0, 500),
            shopify_synced_at: now,
          }).eq("id", listingId);
          if (shopifyStateError) throw new Error(`shopify_reconciliation_state_write_failed:${shopifyStateError.message}`);
        }
        results.push({ listingId, ok: true, inventory, orderable, baseSyncError, shopifySyncError });
      } catch (error) {
        results.push({
          listingId,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const errors = results.filter((item) => !item.ok && !item.blocked).length + baseErrors + baseSyncSkipped + shopifyStopErrors + shopifyStopSkipped;
    return NextResponse.json({
      ok: errors === 0,
      configured: (listings ?? []).length > 0,
      inspected: results.length,
      updated: results.filter((item) => item.ok).length,
      blocked: results.filter((item) => item.blocked).length,
      errors: results.filter((item) => !item.ok && !item.blocked).length,
      baseUpdated,
      baseErrors,
      baseSyncSkipped,
      shopifyStopped,
      shopifyStopErrors,
      shopifyStopSkipped,
      results,
    }, { status: errors === 0 ? 200 : 207 });
  } catch (error) {
    console.error("[TRACER INVENTORY REFRESH CRON ERROR]", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
