import { NextResponse } from "next/server";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from("shop_listings")
    .select("id,title,slug,selling_price,currency,image_url,inventory,orderable,tracking_available,published,pipeline_stage,pipeline_status,pipeline_reason,shopify_product_id,shopify_variant_id,shopify_handle,shopify_sync_status,shopify_sync_error,shopify_synced_at")
    .order("published_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500, headers: { "Cache-Control": "no-store" } });

  const rows = data ?? [];
  const live = rows.filter((row) => row.published === true && row.pipeline_stage === "PUBLISHED" && row.pipeline_status === "published" && row.shopify_sync_status === "synced" && Boolean(row.shopify_product_id) && row.orderable === true && row.tracking_available === true && Number(row.inventory) > 0 && Number(row.selling_price) > 0 && typeof row.image_url === "string" && /^https?:\/\//i.test(row.image_url));

  return NextResponse.json({
    ok: true,
    contract: "published + gate-passed + synced + in-stock + orderable + trackable",
    counts: { inspected: rows.length, live: live.length, shopifyLinked: rows.filter((row) => Boolean(row.shopify_product_id)).length, syncFailed: rows.filter((row) => row.shopify_sync_status === "failed").length },
    products: live.map((row) => ({ id: row.id, title: row.title, slug: row.slug, price: row.selling_price, currency: row.currency, inventory: row.inventory, shopifyProductId: row.shopify_product_id, shopifyHandle: row.shopify_handle })),
  }, { headers: { "Cache-Control": "no-store" } });
}
