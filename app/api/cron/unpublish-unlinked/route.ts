import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireCronAuth } from "@/lib/security/cron-auth";
import { getLinkedSupplierListingIds } from "@/lib/catalog/canonical-supplier-identity";
import { syncPublishedListingsToShopify } from "@/lib/shopify/sync-published-listings";
import { publishPublishedListingsToBase } from "@/lib/channels/base-publisher";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Reconciles only listings without a verified canonical supplier identity. */
export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const db = createSupabaseAdminClient();
  const { data, error } = await db.from("shop_listings")
    .select("id,supplier_listing_id,published,orderable,pipeline_reason,shopify_product_id,shopify_sync_status,base_item_id,base_publication_status,base_last_error")
    .or("published.eq.true,and(shopify_product_id.not.is.null,shopify_sync_status.is.null),and(shopify_product_id.not.is.null,shopify_sync_status.neq.blocked,shopify_sync_status.neq.synced),and(base_item_id.not.is.null,base_last_error.is.null),and(base_item_id.not.is.null,base_last_error.neq.supplier_identity_unlinked_hidden,base_last_error.neq.tracer_unpublished_hidden)")
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) return NextResponse.json({ ok: false, stage: "read", error: error.message }, { status: 500 });

  const linkedIds = await getLinkedSupplierListingIds((data ?? []).map((row) => row.supplier_listing_id));
  const unlinked = (data ?? []).filter((row) => !row.supplier_listing_id || !linkedIds.has(String(row.supplier_listing_id)));
  const needsBlock = unlinked.filter((row) => row.published === true || row.orderable !== false || row.pipeline_reason !== "supplier_identity_unlinked");
  if (needsBlock.length > 0) {
    const now = new Date().toISOString();
    const { error: updateError } = await db.from("shop_listings").update({
      published: false,
      orderable: false,
      published_at: null,
      pipeline_stage: "BLOCKED",
      pipeline_status: "blocked",
      pipeline_reason: "supplier_identity_unlinked",
      pipeline_updated_at: now,
      updated_at: now,
    }).in("id", needsBlock.map((row) => row.id));
    if (updateError) return NextResponse.json({ ok: false, stage: "block", error: updateError.message }, { status: 500 });
  }

  const shopifyPending = unlinked.filter((row) => row.shopify_product_id && row.shopify_sync_status !== "blocked").slice(0, 15);
  const basePending = unlinked.filter((row) => row.base_item_id && row.base_last_error !== "supplier_identity_unlinked_hidden").slice(0, 50);
  let shopify: unknown = { skipped: true };
  let base: unknown = { skipped: true };
  const errors: string[] = [];
  if (shopifyPending.length > 0) {
    try {
      shopify = await syncPublishedListingsToShopify(15, shopifyPending.map((row) => String(row.id)));
      const result = shopify as { failed?: number; errors?: Array<{ listingId: string; error: string }> };
      if ((result.failed ?? 0) > 0) errors.push(`shopify_unpublish_failed:${JSON.stringify(result.errors?.slice(0, 5) ?? [])}`);
    } catch (cause) { errors.push(`shopify:${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  if (basePending.length > 0) {
    try {
      base = await publishPublishedListingsToBase(50, basePending.map((row) => String(row.id)));
      const result = base as { attempted?: number; failed?: number; results?: Array<{ listingId: string; ok: boolean; error?: string }> };
      if ((result.attempted ?? 0) === 0 && (result.results?.length ?? 0) === 0) errors.push("base_unpublish_not_attempted:credentials_not_configured_or_no_result");
      if ((result.failed ?? 0) > 0) errors.push(`base_unpublish_failed:${JSON.stringify(result.results?.filter((item) => !item.ok).slice(0, 5) ?? [])}`);
    } catch (cause) { errors.push(`base:${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    candidatesChecked: (data ?? []).length,
    unlinkedFound: unlinked.length,
    databaseBlocked: needsBlock.length,
    shopifyAttempted: shopifyPending.length,
    baseAttempted: basePending.length,
    shopify,
    base,
    errors,
  }, { status: errors.length === 0 ? 200 : 207 });
}
