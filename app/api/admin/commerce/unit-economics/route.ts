import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { summarizeUnitEconomics, type UnitEconomicsInput } from "@/lib/commerce/unit-economics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Row = Record<string, unknown>;

/**
 * Read-only ad economics for every priced variant: break-even ROAS and the
 * maximum ad spend per purchase, from the stored price, fee and profit.
 * No writes, no customer data.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;
  try {
    const db = createSupabaseAdminClient();
    const readAll = async (query: (from: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, stage: string) => {
      const rows: Row[] = [];
      for (let from = 0; from < 50_000; from += 1000) {
        const { data, error } = await query(from);
        if (error) throw new Error(stage + ":" + error.message);
        rows.push(...((data ?? []) as Row[]));
        if ((data ?? []).length < 1000) return rows;
      }
      throw new Error(stage + ":incomplete");
    };
    const readIn = async (ids: string[], query: (chunk: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, stage: string) => {
      const rows: Row[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const { data, error } = await query(ids.slice(offset, offset + 100));
        if (error) throw new Error(stage + ":" + error.message);
        rows.push(...((data ?? []) as Row[]));
      }
      return rows;
    };

    const [prices, listings] = await Promise.all([
      readAll((from) => db.from("commerce_prices").select("variant_id,supplier_offer_id,currency,selling_price,fee_amount,expected_profit")
        .eq("currency", "JPY").order("variant_id").range(from, from + 999), "commerce_prices_read_failed"),
      readAll((from) => db.from("channel_listings").select("variant_id,channel,status")
        .eq("status", "published").order("id").range(from, from + 999), "channel_listings_read_failed"),
    ]);
    const variantIds = [...new Set(prices.map((row) => String(row.variant_id)))];
    const offerIds = [...new Set(prices.map((row) => String(row.supplier_offer_id ?? "")).filter(Boolean))];
    const [variants, offers] = await Promise.all([
      readIn(variantIds, (ids) => db.from("commerce_variants").select("id,title_ja").in("id", ids), "commerce_variants_read_failed"),
      readIn(offerIds, (ids) => db.from("supplier_offers").select("id,inventory,source_status,tracking_supported,ship_to,last_checked_at").in("id", ids), "supplier_offers_read_failed"),
    ]);
    const titleById = new Map(variants.map((row) => [String(row.id), typeof row.title_ja === "string" ? row.title_ja : null]));
    const offerById = new Map(offers.map((row) => [String(row.id), row]));
    const live = new Map<string, Set<string>>();
    for (const row of listings) {
      const set = live.get(String(row.variant_id)) ?? new Set<string>();
      set.add(String(row.channel));
      live.set(String(row.variant_id), set);
    }
    const now = Date.now();
    const inputs: UnitEconomicsInput[] = prices.map((row) => {
      const offer = offerById.get(String(row.supplier_offer_id ?? ""));
      const checked = typeof offer?.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
      const channels = live.get(String(row.variant_id));
      return {
        variantId: String(row.variant_id),
        title: titleById.get(String(row.variant_id)) ?? null,
        sellingPrice: Number(row.selling_price),
        feeAmount: Number(row.fee_amount),
        expectedProfit: Number(row.expected_profit),
        inventory: offer ? Number(offer.inventory) : null,
        offerFresh: Boolean(offer && offer.source_status === "verified" && offer.tracking_supported === true && offer.ship_to === "JP"
          && Number.isFinite(checked) && now - checked <= 24 * 60 * 60_000),
        liveOnShopify: channels?.has("shopify") ?? false,
        liveOnBase: channels?.has("base") ?? false,
      };
    });
    return NextResponse.json({ ok: true, readOnly: true, generatedAt: new Date().toISOString(), ...summarizeUnitEconomics(inputs) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, readOnly: true, error: error instanceof Error ? error.message.slice(0, 300) : String(error) }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
