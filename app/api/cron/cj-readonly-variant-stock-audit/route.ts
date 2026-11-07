import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { fetchCJVariantStock } from "@/lib/sources/cj";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Read-only, exact-VID CJ stock audit.
 * This endpoint deliberately does not persist supplier evidence, update catalog
 * records, publish/unpublish channel listings, or place supplier orders.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const ids = [...new Set((url.searchParams.get("supplierListingIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)))];

  if (ids.length < 1 || ids.length > 15) {
    return NextResponse.json({
      ok: false,
      error: "supplierListingIds must contain 1 to 15 valid UUIDs",
      requestedCount: ids.length,
    }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const { data: rows, error } = await db
    .from("supplier_listings")
    .select("id,supplier,supplier_product_id,supplier_variant_id,sku,inventory,inventory_checked_at,ship_to")
    .in("id", ids)
    .eq("supplier", "cj");

  if (error) {
    return NextResponse.json({ ok: false, error: "supplier listing lookup failed" }, { status: 500 });
  }
  if ((rows ?? []).length !== ids.length) {
    return NextResponse.json({
      ok: false,
      error: "one or more IDs are missing or are not CJ supplier listings",
      requestedCount: ids.length,
      matchedCount: rows?.length ?? 0,
    }, { status: 404 });
  }

  const byId = new Map((rows ?? []).map((row) => [String(row.id), row]));
  const results = [];
  // fetchCJVariantStock uses the shared CJ quota circuit and shared request
  // limiter. Keep this loop sequential to preserve the provider's QPS limit.
  for (const id of ids) {
    const row = byId.get(id)!;
    const vid = String(row.supplier_variant_id ?? "").trim();
    if (!vid) {
      results.push({
        supplierListingId: id,
        supplierProductId: row.supplier_product_id,
        supplierVariantId: null,
        sku: row.sku,
        storedInventory: row.inventory,
        storedInventoryCheckedAt: row.inventory_checked_at,
        liveInventory: null,
        error: "supplier_variant_id_missing",
      });
      continue;
    }
    try {
      const liveInventory = await fetchCJVariantStock(vid);
      results.push({
        supplierListingId: id,
        supplierProductId: row.supplier_product_id,
        supplierVariantId: vid,
        sku: row.sku,
        shipTo: row.ship_to,
        storedInventory: row.inventory,
        storedInventoryCheckedAt: row.inventory_checked_at,
        liveInventory,
        error: null,
      });
    } catch (cause) {
      results.push({
        supplierListingId: id,
        supplierProductId: row.supplier_product_id,
        supplierVariantId: vid,
        sku: row.sku,
        storedInventory: row.inventory,
        storedInventoryCheckedAt: row.inventory_checked_at,
        liveInventory: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      // Quota/circuit failures should stop the batch rather than continue
      // making requests against a blocked or unknown provider state.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/quota|circuit|429/i.test(message)) break;
    }
  }

  const failed = results.filter((item) => item.error !== null).length;
  return NextResponse.json({
    ok: failed === 0 && results.length === ids.length,
    phase: "cj_readonly_variant_stock_audit",
    readOnly: true,
    persisted: false,
    publicationChanged: false,
    supplierOrdersPlaced: false,
    requestedCount: ids.length,
    checkedCount: results.filter((item) => item.liveInventory !== null).length,
    failedCount: failed,
    results,
  }, { status: failed === 0 && results.length === ids.length ? 200 : 207 });
}
