import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireAutomationAuth } from "@/lib/security/cron-auth";
import { isShopifyConfigured } from "@/lib/shopify/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const authError = await requireAutomationAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const [listings, supply, recentReverify] = await Promise.all([
    db.from("shop_listings").select("id,published,pipeline_stage,pipeline_status,pipeline_reason,shopify_product_id,shopify_sync_status,inventory,orderable,tracking_available,selling_price,image_url").limit(1000),
    db.from("supplier_listings").select("id,identity_status,identity_method,verification_status,orderable,inventory_confirmed,inventory,tracking_available,api_available,supplier_variant_id,supplier_product_id").eq("supplier", "cj").limit(2000),
    db.from("cron_runs").select("started_at,finished_at,processed,failed,metadata,status").eq("job_name", "cj-identity-reverify-cursor").order("started_at", { ascending: false }).limit(5),
  ]);
  if (listings.error) return NextResponse.json({ ok: false, error: listings.error.message }, { status: 500 });
  if (supply.error) return NextResponse.json({ ok: false, error: supply.error.message }, { status: 500 });
  if (recentReverify.error) return NextResponse.json({ ok: false, error: recentReverify.error.message }, { status: 500 });

  const rows = listings.data ?? [];
  const cj = supply.data ?? [];
  const live = rows.filter((row) => row.published === true && row.pipeline_stage === "PUBLISHED" && row.pipeline_status === "published" && row.pipeline_reason === "sales_test_gate_passed" && Number(row.inventory) > 0 && row.orderable === true && row.tracking_available === true && Number(row.selling_price) > 0 && typeof row.image_url === "string" && /^https?:\/\//.test(row.image_url));
  const linkedCj = cj.filter((row) => row.identity_status === "linked" && row.identity_method && row.verification_status === "verified" && row.orderable === true && row.inventory_confirmed === true && Number(row.inventory) > 0 && row.tracking_available === true && row.api_available === true && row.supplier_product_id && row.supplier_variant_id);

  return NextResponse.json({
    ok: true,
    shopifyConfigured: isShopifyConfigured(),
    storefrontContract: "published + sales_test_gate_passed + shopify_synced + in_stock + orderable + trackable",
    shopListings: { inspected: rows.length, live: live.length, published: rows.filter((row) => row.published === true).length, shopifySynced: rows.filter((row) => row.shopify_sync_status === "synced").length },
    cjSupply: { inspected: cj.length, canonicalLinkedReady: linkedCj.length, supplyDiscovered: cj.filter((row) => row.identity_status === "supply_discovered").length, retryable: cj.filter((row) => row.verification_status === "retryable").length },
    reverify: recentReverify.data ?? [],
    blockers: [
      ...(!isShopifyConfigured() ? ["shopify_credentials_missing"] : []),
      ...(live.length === 0 ? ["no_gate_passed_shopify_ready_listing"] : []),
      ...(linkedCj.length === 0 ? ["no_canonical_linked_cj_supply"] : []),
    ],
  }, { headers: { "Cache-Control": "no-store" } });
}
