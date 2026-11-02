import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { getBaseItemDetail, isBaseConfigured, setBaseItemListOrder } from "@/lib/channels/base";

export const runtime = "nodejs";
export const maxDuration = 30;

const PRIORITY_LISTING_ID = "1ae04dd1-a228-43b7-b003-3a2fb75da98a";

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "BASE_OAUTH_CONFIG_INCOMPLETE" }, { status: 503 });
  }

  try {
    const db = createSupabaseAdminClient();
    const { data: listing, error } = await db
      .from("shop_listings")
      .select("id,base_item_id,published,base_publication_status")
      .eq("id", PRIORITY_LISTING_ID)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!listing || listing.published !== true || listing.base_publication_status !== "published" || !listing.base_item_id) {
      console.warn("[TRACER BASE PRIORITY PIN SKIPPED]", {
        reason: "priority_listing_not_published_on_BASE",
        listingId: PRIORITY_LISTING_ID,
      });
      return NextResponse.json({
        ok: false,
        skipped: true,
        reason: "priority_listing_not_published_on_BASE",
        listingId: PRIORITY_LISTING_ID,
      }, { status: 409 });
    }

    const itemId = String(listing.base_item_id);
    const before = await getBaseItemDetail(itemId);
    const beforeVisible = before.visible === true || Number(before.visible) === 1;
    const beforeStock = Number(before.stock);
    if (!beforeVisible || !Number.isFinite(beforeStock) || beforeStock <= 0) {
      console.warn("[TRACER BASE PRIORITY PIN SKIPPED]", {
        reason: !beforeVisible ? "BASE_item_not_visible" : "BASE_stock_not_positive",
        listingId: PRIORITY_LISTING_ID,
        baseItemId: itemId,
        visible: beforeVisible,
        stock: Number.isFinite(beforeStock) ? beforeStock : null,
      });
      return NextResponse.json({
        ok: false,
        skipped: true,
        reason: !beforeVisible ? "BASE_item_not_visible" : "BASE_stock_not_positive",
        listingId: PRIORITY_LISTING_ID,
        baseItemId: itemId,
        visible: beforeVisible,
        stock: Number.isFinite(beforeStock) ? beforeStock : null,
      }, { status: 409 });
    }

    const beforeOrder = Number(before.list_order);
    if (beforeOrder !== 1) await setBaseItemListOrder(itemId, 1);

    const after = await getBaseItemDetail(itemId);
    const afterVisible = after.visible === true || Number(after.visible) === 1;
    const afterStock = Number(after.stock);
    const afterOrder = Number(after.list_order);
    if (!afterVisible || !Number.isFinite(afterStock) || afterStock <= 0 || afterOrder !== 1) {
      throw new Error("BASE_PRIORITY_PIN_READBACK_MISMATCH");
    }

    console.info("[TRACER BASE PRIORITY PIN]", {
      ok: true,
      listingId: PRIORITY_LISTING_ID,
      baseItemId: itemId,
      listOrder: afterOrder,
      visible: afterVisible,
      stock: afterStock,
      writePerformed: beforeOrder !== 1,
    });
    return NextResponse.json({
      ok: true,
      pinned: true,
      listingId: PRIORITY_LISTING_ID,
      baseItemId: itemId,
      listOrder: afterOrder,
      visible: afterVisible,
      stock: afterStock,
      writePerformed: beforeOrder !== 1,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[TRACER BASE PRIORITY PIN FAILED]", {
      listingId: PRIORITY_LISTING_ID,
      error: error instanceof Error ? error.message : "BASE_PRIORITY_PIN_FAILED",
    });
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "BASE_PRIORITY_PIN_FAILED",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
