import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";

const db = createSupabaseAdminClient();

const { data: published, error: publishedError } = await db
  .from("shop_listings")
  .select("id,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,selling_price,image_url,inventory,orderable,shopify_product_id,shopify_sync_status")
  .eq("published", true)
  .limit(1000);
if (publishedError) throw new Error(publishedError.message);

const violations: string[] = [];
for (const listing of published ?? []) {
  const id = String(listing.id);
  if (!hasPassedSalesTestGate(listing)) violations.push(`${id}:published_without_sales_test_gate`);
  const price = Number(listing.selling_price);
  if (!Number.isFinite(price) || price <= 0) violations.push(`${id}:invalid_price`);
  if (typeof listing.image_url !== "string" || !/^https?:\/\//i.test(listing.image_url)) violations.push(`${id}:invalid_image_url`);
  if (listing.inventory !== null && Number(listing.inventory) <= 0) violations.push(`${id}:published_zero_inventory`);
  if (listing.orderable !== true) violations.push(`${id}:published_not_orderable`);
}

const shopifyReady = (published ?? []).filter((listing) => Boolean(listing.shopify_product_id) && listing.shopify_sync_status === "synced");
const shopifyPending = (published ?? []).filter((listing) => !listing.shopify_product_id || listing.shopify_sync_status !== "synced");

const { count: gateCount, error: gateError } = await db
  .from("shop_listings")
  .select("id", { count: "exact", head: true })
  .eq("published", true)
  .eq("pipeline_stage", "PUBLISHED")
  .eq("pipeline_status", "published")
  .eq("pipeline_reason", "sales_test_gate_passed");
if (gateError) throw new Error(gateError.message);

console.log(JSON.stringify({
  ok: violations.length === 0,
  publishedCount: published?.length ?? 0,
  canonicalGateCount: gateCount ?? 0,
  shopifyReadyCount: shopifyReady.length,
  shopifyPendingCount: shopifyPending.length,
  violations,
}, null, 2));

if (violations.length) process.exit(1);
