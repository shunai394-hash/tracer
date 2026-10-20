import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncCommerceListings } from "@/lib/commerce/publish";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_VARIANTS_PER_CHANNEL = 20;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  try {
    const [baseRead, shopifyRead] = await Promise.all([
      db.from("channel_listings").select("variant_id").eq("channel", "base").eq("status", "published").limit(5000),
      db.from("channel_listings").select("variant_id").eq("channel", "shopify").eq("status", "published").limit(5000),
    ]);
    if (baseRead.error) throw new Error("base_published_variants_read_failed:" + baseRead.error.message);
    if (shopifyRead.error) throw new Error("shopify_published_variants_read_failed:" + shopifyRead.error.message);

    const baseIds = new Set((baseRead.data ?? []).map((row) => String(row.variant_id)).filter(Boolean));
    const shopifyIds = new Set((shopifyRead.data ?? []).map((row) => String(row.variant_id)).filter(Boolean));
    const baseMissing = [...shopifyIds].filter((id) => !baseIds.has(id)).slice(0, MAX_VARIANTS_PER_CHANNEL);
    const shopifyMissing = [...baseIds].filter((id) => !shopifyIds.has(id)).slice(0, MAX_VARIANTS_PER_CHANNEL);

    const results: Record<string, unknown> = {};
    results.base = baseMissing.length
      ? await syncCommerceListings("base", baseMissing.length, true, baseMissing)
      : { attempted: 0, reason: "no_missing_published_variants" };
    results.shopify = shopifyMissing.length
      ? await syncCommerceListings("shopify", shopifyMissing.length, true, shopifyMissing)
      : { attempted: 0, reason: "no_missing_published_variants" };

    const [baseAfter, shopifyAfter] = await Promise.all([
      db.from("channel_listings").select("variant_id").eq("channel", "base").eq("status", "published").limit(5000),
      db.from("channel_listings").select("variant_id").eq("channel", "shopify").eq("status", "published").limit(5000),
    ]);
    if (baseAfter.error) throw new Error("base_post_reconcile_read_failed:" + baseAfter.error.message);
    if (shopifyAfter.error) throw new Error("shopify_post_reconcile_read_failed:" + shopifyAfter.error.message);
    const finalBase = new Set((baseAfter.data ?? []).map((row) => String(row.variant_id)).filter(Boolean));
    const finalShopify = new Set((shopifyAfter.data ?? []).map((row) => String(row.variant_id)).filter(Boolean));
    const baseOnly = [...finalBase].filter((id) => !finalShopify.has(id));
    const shopifyOnly = [...finalShopify].filter((id) => !finalBase.has(id));
    const parity = baseOnly.length === 0 && shopifyOnly.length === 0;

    console.info("[TRACER CATALOG PARITY]", JSON.stringify({
      parity, basePublished: finalBase.size, shopifyPublished: finalShopify.size,
      baseOnly: baseOnly.length, shopifyOnly: shopifyOnly.length,
      baseRepairAttempted: baseMissing.length, shopifyRepairAttempted: shopifyMissing.length,
      baseRepairErrors: baseOnly.slice(0, 10), shopifyRepairErrors: shopifyOnly.slice(0, 10),
      generatedAt: new Date().toISOString(),
    }));
    return NextResponse.json({
      ok: parity, parity,
      publishedVariants: { base: finalBase.size, shopify: finalShopify.size },
      remainingMismatch: { baseOnly: baseOnly.length, shopifyOnly: shopifyOnly.length },
      repairAttempted: { base: baseMissing.length, shopify: shopifyMissing.length },
      results,
    }, { status: parity ? 200 : 207 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
