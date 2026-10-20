import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncCommerceListings } from "@/lib/commerce/publish";

export const runtime = "nodejs";
export const maxDuration = 300;

type ListingState = { id: string; variant_id: string; channel: string; status: string; selling_price: number | null };

/** A variant is in parity only when exactly one row exists per channel and public states match. */
function mismatchedVariantIds(rows: ListingState[]): string[] {
  const byVariant = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const variantId = String(row.variant_id ?? "").trim();
    const channel = String(row.channel ?? "").trim().toLowerCase();
    if (!variantId || (channel !== "base" && channel !== "shopify")) continue;
    const channels = byVariant.get(variantId) ?? new Map<string, string[]>();
    const states = channels.get(channel) ?? [];
    states.push(String(row.status ?? ""));
    channels.set(channel, states);
    byVariant.set(variantId, channels);
  }
  return [...byVariant.entries()]
    .filter(([, channels]) => {
      const base = channels.get("base") ?? [];
      const shopify = channels.get("shopify") ?? [];
      // Missing channel rows, duplicate rows, and different public states are mismatches.
      return base.length !== 1 || shopify.length !== 1 ||
        (base[0] === "published") !== (shopify[0] === "published");
    })
    .map(([variantId]) => variantId);
}

async function readStates(variantIds?: string[]): Promise<ListingState[]> {
  const db = createSupabaseAdminClient();
  let query = db.from("channel_listings").select("id,variant_id,channel,status,selling_price")
    .in("channel", ["base", "shopify"]);
  if (variantIds) query = query.in("variant_id", variantIds);
  const { data, error } = await query.limit(5000);
  if (error) throw new Error("channel_parity_read_failed:" + error.message);
  return (data ?? []) as ListingState[];
}

/**
 * Reconcile only variant IDs whose BASE and Shopify listing states differ.
 * Both publishers run their normal supplier, inventory, shipping, tracking and
 * profit checks; this route never forces a listing public.
 */
export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  try {
    const before = await readStates();
    const allMismatches = mismatchedVariantIds(before);
    const variantIds = allMismatches.slice(0, 50);
    if (variantIds.length === 0) {
      return NextResponse.json({
        ok: true,
        phase: "commerce_channel_parity_repair",
        baseRows: before.filter((row) => row.channel === "base").length,
        shopifyRows: before.filter((row) => row.channel === "shopify").length,
        mismatchedVariants: 0,
        repairedVariants: 0,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const [base, shopify] = await Promise.all([
      syncCommerceListings("base", variantIds.length, false, variantIds),
      syncCommerceListings("shopify", variantIds.length, false, variantIds),
    ]);
    const after = await readStates(variantIds);
    const remaining = mismatchedVariantIds(after);
    const result = {
      ok: remaining.length === 0 && Number(base.failed ?? 0) === 0 && Number(shopify.failed ?? 0) === 0,
      phase: "commerce_channel_parity_repair",
      scannedVariants: new Set(before.map((row) => row.variant_id)).size,
      baseRows: before.filter((row) => row.channel === "base").length,
      shopifyRows: before.filter((row) => row.channel === "shopify").length,
      mismatchedVariantsBefore: allMismatches.length,
      attemptedVariants: variantIds.length,
      remainingMismatchedVariants: remaining,
      remainingMismatchCount: remaining.length + Math.max(0, allMismatches.length - variantIds.length),
      base: {
        processed: base.processed ?? base.published ?? 0,
        failed: base.failed ?? 0,
        errors: (base.results ?? []).filter((item: { ok?: boolean }) => !item.ok).slice(0, 10).map((item: { variantId?: string; error?: string; missingEvidence?: string[] }) => ({ variantId: item.variantId, error: item.error, missingEvidence: item.missingEvidence ?? [] })),
        staleListingErrors: (base.staleListings?.errors ?? []).slice(0, 5),
      },
      shopify: {
        processed: shopify.processed ?? shopify.published ?? 0,
        failed: shopify.failed ?? 0,
        errors: (shopify.results ?? []).filter((item: { ok?: boolean }) => !item.ok).slice(0, 10).map((item: { variantId?: string; error?: string; missingEvidence?: string[] }) => ({ variantId: item.variantId, error: item.error, missingEvidence: item.missingEvidence ?? [] })),
        staleListingErrors: (shopify.staleListings?.errors ?? []).slice(0, 5),
      },
    };
    console.log("[TRACER CHANNEL PARITY REPAIR]", JSON.stringify(result));
    return NextResponse.json(result, { status: result.ok ? 200 : 207, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      phase: "commerce_channel_parity_repair",
      error: error instanceof Error ? error.message.slice(0, 240) : "unknown_error",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
