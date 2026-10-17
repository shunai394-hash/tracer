import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseItemDetail, isBaseConfigured } from "@/lib/channels/base";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Bounded, read-only reconciliation of current commerce BASE listings against
 * the actual BASE API. This deliberately does not repair mappings or edit prices.
 * Call with increasing offsets to cover the complete channel_listings set.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  if (!isBaseConfigured()) {
    return NextResponse.json({ ok: false, error: "base_oauth_not_configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const parsedLimit = Number(url.searchParams.get("limit") || 20);
  const parsedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Number.isFinite(parsedLimit) ? Math.min(25, Math.max(1, Math.floor(parsedLimit))) : 20;
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : 0;
  const db = createSupabaseAdminClient();

  const { data: listings, error, count } = await db
    .from("channel_listings")
    .select("id,external_product_id,external_variant_id,external_sku,selling_price,status", { count: "exact" })
    .eq("channel", "base")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("[TRACER BASE CHANNEL EXTERNAL READBACK] database read failed", {
      offset, limit, code: error.code ?? null,
    });
    return NextResponse.json({ ok: false, error: "base_channel_listing_read_failed" }, { status: 500 });
  }

  const results = await Promise.all((listings ?? []).map(async (listing) => {
    const listingId = String(listing.id);
    const baseItemId = String(listing.external_product_id ?? "").trim();
    const expectedPrice = Number(listing.selling_price);
    if (!/^\d+$/.test(baseItemId)) {
      return {
        listingId, baseItemId: baseItemId || null, status: listing.status,
        skuPresent: Boolean(listing.external_sku), expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : null,
        externalPrice: null, externalVisible: null, externalStock: null,
        priceMatches: false, visibilityMatches: false, error: "external_product_id_invalid",
      };
    }
    try {
      const item = await getBaseItemDetail(baseItemId);
      const rawPrice = Number(item.price);
      const externalPrice = Number.isFinite(rawPrice) ? rawPrice : null;
      const rawVisible = item.visible;
      const externalVisible = rawVisible === true || rawVisible === 1 || rawVisible === "1";
      const rawStock = Number(item.stock);
      const externalStock = Number.isFinite(rawStock) ? rawStock : null;
      const priceMatches = Number.isFinite(expectedPrice) && expectedPrice > 0 &&
        externalPrice !== null && externalPrice === Math.round(expectedPrice);
      const visibilityMatches = listing.status === "published" ? externalVisible : !externalVisible;
      return {
        listingId, baseItemId, status: listing.status,
        skuPresent: Boolean(listing.external_sku), expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : null,
        externalPrice, externalVisible, externalStock,
        priceMatches, visibilityMatches, error: null,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        listingId, baseItemId, status: listing.status,
        skuPresent: Boolean(listing.external_sku), expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : null,
        externalPrice: null, externalVisible: null, externalStock: null,
        priceMatches: false, visibilityMatches: false,
        error: (() => {
          // Keep the HTTP status while excluding the provider response body/token details.
          const match = message.match(/^([A-Z0-9_]+)(?::HTTP_(\d{3}))?/);
          return match ? [match[1], match[2] ? `HTTP_${match[2]}` : null].filter(Boolean).join(":") : "BASE_ITEM_DETAIL_FAILED";
        })(),
      };
    }
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    offset, limit, totalRows: count ?? null, rowsReturned: results.length,
    priceMatches: results.filter((row) => row.priceMatches).length,
    priceMismatches: results.filter((row) => !row.error && !row.priceMatches).length,
    visibilityMatches: results.filter((row) => row.visibilityMatches).length,
    visibilityMismatches: results.filter((row) => !row.error && !row.visibilityMatches).length,
    readErrors: results.filter((row) => row.error !== null).length,
    readErrorCounts: results.reduce<Record<string, number>>((counts, row) => {
      if (row.error) counts[row.error] = (counts[row.error] ?? 0) + 1;
      return counts;
    }, {}),
    missingSku: results.filter((row) => !row.skuPresent).length,
    nextOffset: offset + results.length,
    complete: count !== null && offset + results.length >= count,
  };
  console.info("[TRACER BASE CHANNEL EXTERNAL READBACK]", summary);
  return NextResponse.json({ ok: summary.readErrors === 0, ...summary, results }, {
    status: summary.readErrors > 0 ? 207 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
