import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createShopifyProduct, isShopifyConfigured, updateShopifyProduct } from "@/lib/shopify/admin";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

export type ShopifySyncResult = {
  configured: boolean;
  attempted: number;
  synced: number;
  failed: Array<{ listingId: string; error: string }>;
};

/**
 * Shopify is downstream only. A listing must carry the same canonical Sales
 * Test Gate provenance used by BASE and NEWFIND; published=true alone is not
 * sufficient because legacy rows may predate the current gate.
 */
export async function syncPublishedListingsToShopify(listingIds?: string[]): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) return { configured: false, attempted: 0, synced: 0, failed: [] };

  const db = createSupabaseAdminClient();
  let query = db
    .from("shop_listings")
    .select("id,title,description,image_url,selling_price,currency,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,slug,shopify_product_id,shopify_variant_id")
    .eq("published", true);
  if (listingIds?.length) query = query.in("id", listingIds);

  const { data: listings, error } = await query.limit(100);
  if (error) throw new Error(error.message);

  const gatedListings = (listings ?? []).filter((listing) => hasPassedSalesTestGate(listing));
  const blockedListings = (listings ?? []).filter((listing) => !hasPassedSalesTestGate(listing));
  const result: ShopifySyncResult = { configured: true, attempted: gatedListings.length, synced: 0, failed: [] };

  for (const listing of blockedListings) {
    const listingId = String(listing.id);
    await db.from("shop_listings").update({ shopify_status: "blocked", shopify_last_error: "sales_test_gate_not_passed" }).eq("id", listingId);
    result.failed.push({ listingId, error: "sales_test_gate_not_passed" });
  }

  for (const listing of gatedListings) {
    const listingId = String(listing.id);
    const price = asNumber(listing.selling_price);
    if (price === null || price <= 0) {
      result.failed.push({ listingId, error: "selling_price_invalid" });
      await db.from("shop_listings").update({ shopify_status: "blocked", shopify_last_error: "selling_price_invalid" }).eq("id", listingId);
      continue;
    }

    const description = typeof listing.description === "string" ? listing.description : "";
    const descriptionHtml = description ? `<p>${escapeHtml(description).replace(/\n/g, "<br />")}</p>` : `<p>${escapeHtml(String(listing.title))}</p>`;

    try {
      const shopify = listing.shopify_product_id
        ? await updateShopifyProduct({ productId: String(listing.shopify_product_id), variantId: listing.shopify_variant_id ? String(listing.shopify_variant_id) : null, title: String(listing.title), descriptionHtml, handle: String(listing.slug), price, sku: listingId })
        : await createShopifyProduct({ title: String(listing.title), descriptionHtml, handle: String(listing.slug), price, sku: listingId });
      const variantId = shopify.variants?.nodes?.[0]?.id ?? null;
      const { error: updateError } = await db.from("shop_listings").update({ shopify_product_id: shopify.id, shopify_variant_id: variantId, shopify_status: "active", shopify_last_synced_at: new Date().toISOString(), shopify_last_error: null }).eq("id", listingId);
      if (updateError) throw new Error(updateError.message);
      result.synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ listingId, error: message });
      await db.from("shop_listings").update({ shopify_status: "error", shopify_last_error: message.slice(0, 1000) }).eq("id", listingId);
    }
  }

  return result;
}
