import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();

  const [
    published,
    basePublished,
    cjShippingCandidates,
    newfindPending,
    newfindSent,
    newfindProcessed,
    newfindFailed,
  ] = await Promise.all([
    db.from("shop_listings").select("id", { count: "exact", head: true }).eq("published", true),
    db.from("shop_listings").select("id", { count: "exact", head: true }).eq("base_publication_status", "published"),
    db.from("supplier_listings").select("id", { count: "exact", head: true })
      .eq("supplier", "cj")
      .eq("inventory_confirmed", true)
      .eq("price_confirmed", true)
      .gt("inventory", 0)
      .gt("shipping_cost", 0),
    db.from("newfind_promotion_deliveries").select("listing_id", { count: "exact", head: true }).eq("status", "pending"),
    db.from("newfind_promotion_deliveries").select("listing_id", { count: "exact", head: true }).eq("status", "sent"),
    db.from("newfind_promotion_deliveries").select("listing_id", { count: "exact", head: true }).eq("status", "processed"),
    db.from("newfind_promotion_deliveries").select("listing_id", { count: "exact", head: true }).eq("status", "failed"),
  ]);

  const errors = [
    published.error,
    basePublished.error,
    cjShippingCandidates.error,
    newfindPending.error,
    newfindSent.error,
    newfindProcessed.error,
    newfindFailed.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, error: errors.map((e) => e?.message).join("; ") },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    publishedListings: published.count ?? 0,
    basePublishedListings: basePublished.count ?? 0,
    cjVerifiedShippingCandidates: cjShippingCandidates.count ?? 0,
    newfind: {
      pending: newfindPending.count ?? 0,
      sent: newfindSent.count ?? 0,
      processed: newfindProcessed.count ?? 0,
      failed: newfindFailed.count ?? 0,
    },
  });
}
