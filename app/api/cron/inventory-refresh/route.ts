import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCJVariantStock } from "@/lib/sources/cj/client";
import { getCJConfig } from "@/lib/config/env";
import { isCronAuthorized } from "@/lib/ops/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    if (!isCronAuthorized(request)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    if (!getCJConfig().apiKey) {
      return NextResponse.json({
        ok: true,
        configured: false,
        inspected: 0,
        updated: 0,
        blocked: 0,
        errors: 0,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data: listings, error } = await supabase
      .from("shop_listings")
      .select("id, supplier_listing_id, supplier_name, supplier_variant_id, base_item_id")
      .eq("published", true)
      .eq("supplier_name", "CJdropshipping")
      .not("supplier_variant_id", "is", null)
      .order("updated_at", { ascending: true })
      .limit(20);

    if (error) throw new Error(error.message);

    const results = [];
    for (const listing of listings ?? []) {
      const listingId = String(listing.id);
      const variantId = String(listing.supplier_variant_id);
      try {
        const inventory = await fetchCJVariantStock(variantId);
        const now = new Date().toISOString();

        if (inventory === null) {
          const { error: listingError } = await supabase
            .from("shop_listings")
            .update({
              inventory: null,
              orderable: false,
              pipeline_stage: "INVENTORY_REFRESH",
              pipeline_status: "blocked",
              pipeline_reason: "inventory_unknown",
              pipeline_error: "CJ variant stock could not be verified",
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

          results.push({ listingId, ok: false, blocked: true, reason: "inventory_unknown" });
          continue;
        }

        const orderable = inventory > 0;
        const { error: listingError } = await supabase
          .from("shop_listings")
          .update({
            inventory,
            orderable,
            pipeline_stage: "PUBLISHED",
            pipeline_status: orderable ? "published" : "blocked",
            pipeline_reason: orderable ? "inventory_verified" : "inventory_zero",
            pipeline_error: null,
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

        results.push({ listingId, ok: true, inventory, orderable });
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
      configured: true,
      inspected: results.length,
      updated: results.filter((item) => item.ok).length,
      blocked: results.filter((item) => item.blocked).length,
      errors: results.filter((item) => !item.ok && !item.blocked).length,
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
