import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createBaseItem, editBaseItem, addBaseItemImage, isBaseConfigured } from "@/lib/channels/base";
import { getAutoProcurementEligibility } from "@/lib/procurement/auto-eligibility";
import { hasPassedSalesTestGate, SALES_TEST_GATE_PASSED } from "@/lib/market/sales-test-gate";

export type BasePublicationResult = {
  attempted: number;
  published: number;
  skipped: number;
  failed: number;
  results: Array<{
    listingId: string;
    ok: boolean;
    baseItemId?: string | null;
    skipped?: boolean;
    error?: string;
  }>;
};

export async function publishPublishedListingsToBase(
  limit = 10,
  listingIds?: string[],
): Promise<BasePublicationResult> {
  if (!isBaseConfigured()) {
    return { attempted: 0, published: 0, skipped: 0, failed: 0, results: [] };
  }
  if (listingIds !== undefined && listingIds.length === 0) {
    return { attempted: 0, published: 0, skipped: 0, failed: 0, results: [] };
  }

  const supabase = createSupabaseAdminClient();

  let query = supabase
    .from("shop_listings")
    .select(
      "id,title,description,selling_price,image_url,published,base_item_id,base_publication_status,base_publication_lease_until,inventory,orderable,shipping_cost,supplier_name,supplier_listing_id,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons",
    )
    // Existing BASE items stay in scope so their stock/visibility keep being
    // reconciled (including hiding items TRACER has since unpublished).
    // Only the creation of a NEW BASE item requires the Sales Test Gate.
    .or("published.eq.true,base_item_id.not.is.null");
  if (listingIds && listingIds.length > 0) {
    query = query.in("id", Array.from(new Set(listingIds)));
  }
  const { data: listings, error } = await query
    // Listings not yet on BASE first, so reconciliation cannot starve them.
    .order("base_item_id", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  const results: BasePublicationResult["results"] = [];

  for (const listing of listings ?? []) {
    const listingId = String(listing.id);
    const hasSalesTestGate = hasPassedSalesTestGate(listing);

    // Existing BASE items must be actively reconciled even when TRACER has
    // since unpublished or blocked the listing. Otherwise an old BASE item
    // can remain publicly sellable with stale stock.
    if (listing.base_item_id && listing.published !== true) {
      if (listing.selling_price === null) {
        results.push({ listingId, ok: false, skipped: true, error: "base_hide_price_unknown" });
        continue;
      }
      try {
        await editBaseItem({
          itemId: String(listing.base_item_id),
          title: listing.title,
          detail: listing.description ?? listing.title,
          price: Number(listing.selling_price),
          stock: 0,
          visible: false,
        });
        await supabase.from("shop_listings").update({
          base_publication_status: "published",
          base_publication_lease_until: null,
          base_last_error: null,
          pipeline_stage: "BASE_RECONCILED",
          pipeline_status: "blocked",
          pipeline_reason: "tracer_unpublished",
          pipeline_updated_at: new Date().toISOString(),
        }).eq("id", listingId);
        results.push({ listingId, ok: true, baseItemId: String(listing.base_item_id) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await supabase.from("shop_listings").update({
          base_last_error: message,
          pipeline_stage: "BASE_RECONCILIATION",
          pipeline_status: "failed",
          pipeline_reason: "base_hide_failed",
          pipeline_error: message,
          pipeline_updated_at: new Date().toISOString(),
        }).eq("id", listingId);
        results.push({ listingId, ok: false, error: message });
      }
      continue;
    }

    // New BASE publication is downstream of the Sales Test Gate.
    // Existing BASE items are handled by the reconciliation branch above.
    if (!listing.base_item_id && !hasSalesTestGate) {
      results.push({
        listingId,
        ok: false,
        skipped: true,
        error: "sales_test_gate_not_passed",
      });
      continue;
    }

    const autoProcurement = getAutoProcurementEligibility(
      typeof listing.supplier_name === "string" ? listing.supplier_name : null,
    );
    if (!autoProcurement.eligible) {
      let baseSyncError: string | null = null;
      if (listing.base_item_id && listing.selling_price !== null) {
        try {
          await editBaseItem({
            itemId: String(listing.base_item_id),
            title: listing.title,
            detail: listing.description ?? listing.title,
            price: Number(listing.selling_price),
            stock: 0,
            visible: false,
          });
        } catch (error) {
          baseSyncError = error instanceof Error ? error.message : String(error);
        }
      }

      const now = new Date().toISOString();
      const { error: blockError } = await supabase
        .from("shop_listings")
        .update({
          published: false,
          orderable: false,
          base_publication_lease_until: null,
          pipeline_stage: "BASE_PUBLICATION",
          pipeline_status: "blocked",
          pipeline_reason: "supplier_auto_procurement_capability_missing",
          pipeline_error: baseSyncError,
          pipeline_updated_at: now,
          updated_at: now,
        })
        .eq("id", listingId);
      if (blockError) throw new Error(blockError.message);

      if (listing.supplier_listing_id) {
        const { error: supplierBlockError } = await supabase
          .from("supplier_listings")
          .update({
            orderable: false,
            verification_status: "retryable",
            verification_error: `supplier_auto_procurement_capability_missing:${autoProcurement.missing.join("|")}`,
            fetched_at: now,
          })
          .eq("id", String(listing.supplier_listing_id));
        if (supplierBlockError) throw new Error(supplierBlockError.message);
      }

      results.push({
        listingId,
        ok: false,
        skipped: true,
        error: baseSyncError
          ? `supplier_auto_procurement_capability_missing:${autoProcurement.missing.join("|")}:base_hide_failed:${baseSyncError}`
          : `supplier_auto_procurement_capability_missing:${autoProcurement.missing.join("|")}`,
      });
      continue;
    }

    if (listing.selling_price === null) {
      await supabase.from("shop_listings").update({
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "selling_price_unknown",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "selling_price_unknown" });
      continue;
    }

    if (!listing.image_url) {
      await supabase.from("shop_listings").update({
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "image_unknown",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "image_unknown" });
      continue;
    }

    // Shipping is part of the economics gate. A missing, non-finite, or
    // non-positive supplier shipping cost means the selling price is not
    // economically verified. This applies to existing BASE items too:
    // never leave an already-published item publicly sellable after its
    // supplier economics become unknown.
    const shippingCost =
      listing.shipping_cost === null || listing.shipping_cost === undefined
        ? null
        : Number(listing.shipping_cost);
    if (shippingCost === null || !Number.isFinite(shippingCost) || shippingCost <= 0) {
      if (listing.base_item_id) {
        try {
          await editBaseItem({
            itemId: String(listing.base_item_id),
            title: listing.title,
            detail: listing.description ?? listing.title,
            price: Number(listing.selling_price ?? 0),
            stock: 0,
            visible: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({
            base_last_error: message,
            pipeline_stage: "BASE_RECONCILIATION",
            pipeline_status: "failed",
            pipeline_reason: "base_hide_shipping_unknown_failed",
            pipeline_error: message,
            pipeline_updated_at: new Date().toISOString(),
          }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message });
          continue;
        }
      }
      await supabase.from("shop_listings").update({
        published: false,
        base_publication_status: listing.base_item_id ? "published" : "blocked",
        base_publication_lease_until: null,
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: shippingCost === null ? "shipping_unknown" : "shipping_invalid",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({
        listingId,
        ok: false,
        skipped: true,
        error: shippingCost === null ? "shipping_unknown" : "shipping_invalid",
      });
      continue;
    }

    const availableInventory =
      typeof listing.inventory === "number"
        ? Math.floor(listing.inventory)
        : typeof listing.inventory === "string" && listing.inventory.trim() !== ""
          ? Math.floor(Number(listing.inventory))
          : null;

    // Never expose a BASE item when inventory is unknown, zero, negative, or
    // the supplier has not confirmed the listing as orderable.
    if (
      availableInventory === null ||
      !Number.isFinite(availableInventory) ||
      availableInventory <= 0 ||
      listing.orderable !== true
    ) {
      if (listing.base_item_id && listing.selling_price !== null) {
        try {
          await editBaseItem({
            itemId: String(listing.base_item_id),
            title: listing.title,
            detail: listing.description ?? listing.title,
            price: Number(listing.selling_price),
            stock: 0,
            visible: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({
            base_last_error: message,
            pipeline_stage: "BASE_RECONCILIATION",
            pipeline_status: "failed",
            pipeline_reason: "base_hide_failed",
            pipeline_error: message,
            pipeline_updated_at: new Date().toISOString(),
          }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message });
          continue;
        }
      }
      await supabase.from("shop_listings").update({
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason:
          availableInventory === null || !Number.isFinite(availableInventory)
            ? "inventory_unknown"
            : availableInventory <= 0
              ? "inventory_zero"
              : "supplier_not_orderable",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({
        listingId,
        ok: false,
        skipped: true,
        error:
          availableInventory === null || !Number.isFinite(availableInventory)
            ? "inventory_unknown"
            : availableInventory <= 0
              ? "inventory_zero"
              : "supplier_not_orderable",
      });
      continue;
    }

    try {
      let baseItemId: string | null = listing.base_item_id
        ? String(listing.base_item_id)
        : null;
      const wasBasePublished = listing.base_publication_status === "published";

      const stock = availableInventory as number;

      // Claim the external BASE creation slot atomically before calling BASE.
      // Two concurrent cron invocations can both read base_item_id=NULL, but
      // only one can transition this row to "creating".
      if (!baseItemId) {
        const now = new Date();
        const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
        const status = typeof listing.base_publication_status === "string"
          ? listing.base_publication_status
          : null;
        const lease = listing.base_publication_lease_until
          ? new Date(String(listing.base_publication_lease_until))
          : null;

        if (status === "creating" && lease && lease.getTime() > now.getTime()) {
          results.push({ listingId, ok: false, skipped: true, error: "base_publication_in_progress" });
          continue;
        }

        let claimQuery = supabase
          .from("shop_listings")
          .update({
            base_publication_status: "creating",
            base_publication_lease_until: leaseUntil,
          })
          .eq("id", listingId);

        if (status === null) {
          claimQuery = claimQuery.is("base_publication_status", null);
        } else if (status === "creating") {
          claimQuery = claimQuery
            .eq("base_publication_status", "creating")
            .lt("base_publication_lease_until", now.toISOString());
        } else {
          claimQuery = claimQuery.eq("base_publication_status", status);
        }

        const { data: claimed, error: claimError } = await claimQuery.select("id").maybeSingle();
        if (claimError) throw new Error(claimError.message);
        if (!claimed) {
          results.push({ listingId, ok: false, skipped: true, error: "base_publication_claim_lost" });
          continue;
        }
      }

      if (baseItemId) {
        await editBaseItem({
          itemId: baseItemId,
          title: listing.title,
          detail: listing.description ?? listing.title,
          price: Number(listing.selling_price),
          stock,
          visible: true,
        });

        // A previous run may have created the BASE item but failed while
        // registering its image. Repair that incomplete publication on the
        // next retry instead of leaving a permanently image-less item.
        if (!wasBasePublished) {
          await addBaseItemImage({
            itemId: baseItemId,
            imageNo: 1,
            imageUrl: listing.image_url,
          });
        }
      } else {
        const base = await createBaseItem({
          title: listing.title,
          detail: listing.description ?? listing.title,
          price: Number(listing.selling_price),
          stock,
          visible: true,
        });

        const createdBaseItemId = base.item_id ?? base.item?.item_id;
        if (createdBaseItemId === undefined || createdBaseItemId === null) {
          throw new Error("BASE item_id was not returned");
        }
        baseItemId = String(createdBaseItemId);

        // Persist the external BASE item ID immediately after creation.
        // If image registration or a later DB update fails, a retry must edit
        // the existing BASE item instead of creating a duplicate item.
        const { error: createdItemPersistError } = await supabase
          .from("shop_listings")
          .update({
            base_item_id: baseItemId,
            base_publication_status: "creating",
            base_publication_lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
            base_last_error: null,
          })
          .eq("id", listingId)
          .is("base_item_id", null);
        if (createdItemPersistError) throw new Error(createdItemPersistError.message);

        await addBaseItemImage({
          itemId: baseItemId,
          imageNo: 1,
          imageUrl: listing.image_url,
        });
      }

      const { error: updateError } = await supabase
        .from("shop_listings")
        .update({
          base_item_id: String(baseItemId),
          base_published_at: new Date().toISOString(),
          base_publication_status: "published",
          base_publication_lease_until: null,
          base_last_error: null,
          pipeline_stage: "BASE_PUBLISHED",
          pipeline_status: "published",
          // Keep the gate provenance; only the stage moves on.
          pipeline_reason: hasSalesTestGate ? SALES_TEST_GATE_PASSED : listing.pipeline_reason,
          pipeline_error: null,
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", listingId);

      if (updateError) throw new Error(updateError.message);

      results.push({
        listingId,
        ok: true,
        baseItemId: String(baseItemId),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase
        .from("shop_listings")
        .update({
          base_last_error: message,
          base_publication_status: "failed",
          base_publication_lease_until: null,
          pipeline_stage: "BASE_PUBLICATION",
          pipeline_status: "failed",
          pipeline_reason: "base_publication_failed",
          pipeline_error: message,
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", listingId);

      results.push({ listingId, ok: false, error: message });
    }
  }

  return {
    attempted: results.length,
    published: results.filter((item) => item.ok).length,
    skipped: results.filter((item) => item.skipped).length,
    failed: results.filter((item) => !item.ok && !item.skipped).length,
    results,
  };
}
