import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { calculateCJFreight, fetchCJProductInventory, fetchCJVariantStock } from "@/lib/sources/cj/client";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  const db = createSupabaseAdminClient();

  try {
    const { data: listing, error: listingError } = await db
      .from("shop_listings")
      .select("id,title,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id,published,inventory,orderable")
      .eq("published", true)
      .eq("supplier_name", "cj")
      .order("published_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (listingError) throw new Error(listingError.message);
    if (!listing) return NextResponse.json({ ok: false, error: "published_cj_listing_not_found" }, { status: 404 });

    const productId = String(listing.supplier_product_id ?? "").trim();
    const variantId = String(listing.supplier_variant_id ?? "").trim();
    if (!productId || !variantId) {
      return NextResponse.json({ ok: false, error: "supplier_variant_missing", listingId: listing.id }, { status: 422 });
    }

    let inventory: number | null = null;
    let inventorySource = "variant_stock_endpoint";

    try {
      inventory = await fetchCJVariantStock(variantId);
    } catch (error) {
      console.warn("[TRACER REPAIR FIRST CJ LISTING] variant stock endpoint failed", error);
    }

    if (inventory === null) {
      inventory = await fetchCJProductInventory(productId);
      inventorySource = "product_catalog_exact_product_id";
    }

    const shippingCost = await calculateCJFreight(variantId, {
      startCountryCode: "CN",
      endCountryCode: "JP",
      zip: "1000001",
      quantity: 1,
    });

    const inventoryConfirmed = inventory !== null;
    const shippingConfirmed = shippingCost !== null && shippingCost > 0;
    const orderable = inventoryConfirmed && inventory > 0 && shippingConfirmed;

    if (listing.supplier_listing_id) {
      const { error } = await db
        .from("supplier_listings")
        .update({
          inventory,
          shipping_cost: shippingCost,
          orderable,
          api_available: true,
          inventory_checked_at: new Date().toISOString(),
          shipping_checked_at: new Date().toISOString(),
          last_verified_at: new Date().toISOString(),
          verification_status: inventoryConfirmed && shippingConfirmed ? "verified" : "retryable",
          shipping_status: shippingConfirmed ? "verified" : "unavailable",
          next_verification_at: orderable ? null : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          verification_error: orderable ? null : `live_refresh_failed: inventory=${inventory} shipping=${shippingCost}`,
          verification_attempts: 0,
        })
        .eq("id", String(listing.supplier_listing_id));
      if (error) throw new Error(error.message);
    }

    const { error: shopError } = await db
      .from("shop_listings")
      .update({
        inventory,
        shipping_cost: shippingCost,
        orderable,
        tracking_available: true,
      })
      .eq("id", String(listing.id));
    if (shopError) throw new Error(shopError.message);

    return NextResponse.json({ ok: true, listingId: listing.id, title: listing.title, supplierProductId: productId, supplierVariantId: variantId, inventory, inventorySource, shippingCost, orderable, liveSupplierData: true });
  } catch (error) {
    console.error("[TRACER REPAIR FIRST CJ LISTING]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
