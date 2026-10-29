import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncCommerceListings } from "@/lib/commerce/publish";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MIN_EXPECTED_PROFIT_JPY = 2500;
const CHANNELS = ["base", "shopify"] as const;

async function withdrawBatch(channel: (typeof CHANNELS)[number], limit: number) {
  const db = createSupabaseAdminClient();
  const { data: listings, error: listingError } = await db.from("channel_listings")
    .select("variant_id,external_product_id,last_synced_at")
    .eq("channel", channel)
    .eq("status", "published")
    .not("external_product_id", "is", null)
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(1000);
  if (listingError) throw new Error(channel + "_listing_read_failed:" + listingError.message);

  const variantIds = [...new Set((listings ?? []).map((row) => String(row.variant_id ?? "")).filter(Boolean))];
  if (variantIds.length === 0) return { channel, examined: 0, targeted: 0, result: null };

  const { data: prices, error: priceError } = await db.from("commerce_prices")
    .select("variant_id,currency,expected_profit,calculated_at")
    .in("variant_id", variantIds)
    .order("calculated_at", { ascending: false });
  if (priceError) throw new Error(channel + "_price_read_failed:" + priceError.message);

  const latestPrice = new Map<string, { currency: string; expected_profit: number }>();
  for (const row of prices ?? []) {
    const id = String(row.variant_id ?? "");
    if (!id || latestPrice.has(id)) continue;
    latestPrice.set(id, { currency: String(row.currency ?? ""), expected_profit: Number(row.expected_profit) });
  }

  const targets = variantIds.filter((id) => {
    const price = latestPrice.get(id);
    return !price || price.currency !== "JPY" || !Number.isFinite(price.expected_profit) ||
      price.expected_profit < MIN_EXPECTED_PROFIT_JPY;
  }).slice(0, limit);

  if (targets.length === 0) return { channel, examined: variantIds.length, targeted: 0, result: null };
  const result = await syncCommerceListings(channel, targets.length, false, targets);
  return { channel, examined: variantIds.length, targeted: targets.length, result };
}

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const rawLimit = Number(new URL(request.url).searchParams.get("limit") || 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 50;
  try {
    const results = [];
    for (const channel of CHANNELS) results.push(await withdrawBatch(channel, limit));
    const targeted = results.reduce((sum, item) => sum + item.targeted, 0);
    const failed = results.reduce((sum, item) => sum + (item.result?.failed ?? 0), 0);
    return NextResponse.json({
      ok: failed === 0,
      minimumExpectedProfitJpy: MIN_EXPECTED_PROFIT_JPY,
      batchLimitPerChannel: limit,
      targeted,
      failed,
      results,
      generatedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "minimum_profit_withdrawal_failed",
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
