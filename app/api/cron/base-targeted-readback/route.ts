import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TARGETS = 8;

/**
 * Read-only BASE item audit for a small, explicitly supplied set of item IDs.
 * This endpoint never updates BASE items or TRACER records.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("targetBaseItemIds");
  if (!raw) {
    return NextResponse.json({ ok: false, error: "target_base_item_ids_required" }, { status: 400 });
  }
  const supplied = raw.split(",").map((value) => value.trim());
  if (supplied.some((id) => !/^\d+$/.test(id))) {
    return NextResponse.json({ ok: false, error: "target_base_item_ids_must_be_numeric" }, { status: 400 });
  }
  const targetIds = [...new Set(supplied)];
  if (targetIds.length === 0 || targetIds.length > MAX_TARGETS) {
    return NextResponse.json({ ok: false, error: "target_base_item_ids_limit_exceeded", maxTargets: MAX_TARGETS }, { status: 400 });
  }

  const db = createSupabaseAdminClient();
  const { data: listings, error } = await db
    .from("channel_listings")
    .select("id,external_product_id,external_variant_id,external_sku,selling_price,status")
    .eq("channel", "base")
    .in("external_product_id", targetIds);

  if (error) {
    console.error("[TRACER BASE TARGETED READBACK] database read failed", { code: error.code ?? null });
    return NextResponse.json({ ok: false, error: "base_channel_listing_read_failed" }, { status: 500 });
  }

  const results = await Promise.all(targetIds.map(async (baseItemId) => {
    const mappedListings = (listings ?? [])
      .filter((row) => String(row.external_product_id ?? "") === baseItemId)
      .map((row) => ({
        listingId: String(row.id),
        storedBaseItemId: row.external_product_id == null ? null : String(row.external_product_id),
        expectedSku: String(row.external_sku ?? "").trim() || null,
        expectedPrice: Number.isFinite(Number(row.selling_price)) ? Number(row.selling_price) : null,
        status: row.status,
        externalVariantId: row.external_variant_id == null ? null : String(row.external_variant_id),
      }));

    try {
      const item = await getBaseItemDetail(baseItemId);
      const rawPrice = Number(item.price);
      const rawStock = Number(item.stock);
      const rawVisible = item.visible;
      const externalVisible = rawVisible === true || rawVisible === 1 || rawVisible === "1"
        ? true
        : rawVisible === false || rawVisible === 0 || rawVisible === "0" ? false : null;
      const externalSku = String(item.identifier ?? "").trim() || null;
      const externalPrice = Number.isFinite(rawPrice) ? rawPrice : null;
      const externalStock = Number.isFinite(rawStock) ? rawStock : null;
      return {
        baseItemId,
        exists: true,
        actual: {
          identifier: externalSku,
          title: typeof item.title === "string" ? item.title : null,
          price: externalPrice,
          visible: externalVisible,
          stock: externalStock,
        },
        mappedListings: mappedListings.map((listing) => ({
          ...listing,
          skuMatches: Boolean(listing.expectedSku && externalSku && listing.expectedSku === externalSku),
          priceDifference: listing.expectedPrice !== null && externalPrice !== null
            ? externalPrice - listing.expectedPrice
            : null,
          visibilityMatches: listing.status === "published" ? externalVisible === true
            : listing.status ? externalVisible === false : null,
        })),
        readError: null,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const match = message.match(/^([A-Z0-9_]+)(?::HTTP_(\d{3}))?/);
      const readError = match
        ? [match[1], match[2] ? `HTTP_${match[2]}` : null].filter(Boolean).join(":")
        : "BASE_ITEM_DETAIL_FAILED";
      const notFound = /HTTP_404$/.test(readError);
      return {
        baseItemId,
        exists: notFound ? false : null,
        actual: null,
        mappedListings,
        readError,
      };
    }
  }));

  const readErrors = results.filter((row) => row.readError !== null).length;
  return NextResponse.json({
    ok: readErrors === 0,
    readOnly: true,
    writesPerformed: false,
    generatedAt: new Date().toISOString(),
    targetCount: targetIds.length,
    rowsReturned: results.length,
    readErrors,
    results,
  }, {
    status: readErrors > 0 ? 207 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
