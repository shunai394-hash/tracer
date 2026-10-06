import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createShopifyProduct, isShopifyConfigured, shopifyGraphQL, updateShopifyProduct } from "@/lib/shopify/admin";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";

type Listing = {
  id: string;
  product_id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  selling_price: number | string | null;
  currency: string | null;
  slug: string;
  published: boolean;
  pipeline_stage: string | null;
  pipeline_status: string | null;
  pipeline_reason: string | null;
  selection_reasons: unknown;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  inventory: number | null;
  orderable: boolean;
  tracking_available: boolean;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_handle: string | null;
};

type ShopifyProductNode = {
  id: string;
  handle: string;
  status: string | null;
  vendor: string | null;
  tags: string[];
  variants: { nodes: Array<{ id: string; sku: string | null; price: string | null }> };
};

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function html(value: string | null): string {
  if (!value) return "<p>TRACER selected product.</p>";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

function sku(listing: Listing): string {
  const source = listing.supplier_variant_id || listing.supplier_product_id || listing.id;
  return `TRC-${source}`.slice(0, 100);
}

async function findByHandle(handle: string): Promise<ShopifyProductNode | null> {
  const data = await shopifyGraphQL<{ products: { nodes: ShopifyProductNode[] } }>(
    `query ProductByHandle($query: String!) { products(first: 1, query: $query) { nodes { id handle status vendor tags variants(first: 10) { nodes { id sku price } } } } }`,
    { query: `handle:${handle}` },
  );
  return data.products.nodes[0] ?? null;
}

export type ShopifySyncResult = { configured: boolean; considered: number; synced: number; failed: number; listingIds: string[]; errors: Array<{ listingId: string; error: string }> };

/** Shopify is downstream-only: canonical Sales Test Gate plus live fulfillment evidence are mandatory. */
export async function syncPublishedListingsToShopify(limit = 10): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) return { configured: false, considered: 0, synced: 0, failed: 0, listingIds: [], errors: [] };

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select("id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,shopify_product_id,shopify_variant_id,shopify_handle")
    .eq("published", true)
    .eq("pipeline_stage", "PUBLISHED")
    .eq("pipeline_status", "published")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const candidates = ((data ?? []) as Listing[]).filter((row) => hasPassedSalesTestGate(row) && row.orderable === true && row.tracking_available === true && Number(row.inventory) > 0);
  const results: ShopifySyncResult = { configured: true, considered: candidates.length, synced: 0, failed: 0, listingIds: [], errors: [] };

  for (const row of candidates) {
    try {
      const price = asNumber(row.selling_price);
      if (price === null || price <= 0) throw new Error("selling_price_invalid");
      if (typeof row.image_url !== "string" || !/^https?:\/\//i.test(row.image_url)) throw new Error("image_url_invalid");
      const productInput = { title: row.title, descriptionHtml: html(row.description), handle: row.shopify_handle || row.slug, price, sku: sku(row) };
      const existing = row.shopify_product_id
        ? { id: row.shopify_product_id, handle: row.shopify_handle || row.slug, vendor: "TRACER", tags: ["TRACER"], variants: { nodes: [{ id: row.shopify_variant_id || "", sku: null, price: null }] } }
        : await findByHandle(productInput.handle);
      if (existing && existing.vendor && existing.vendor !== "TRACER" && !existing.tags.includes("TRACER")) throw new Error("shopify_handle_owned_by_non_tracer_product");
      const product = existing
        ? await updateShopifyProduct({ productId: existing.id, title: productInput.title, descriptionHtml: productInput.descriptionHtml, handle: productInput.handle, price: productInput.price, variantId: existing.variants.nodes[0]?.id || null, sku: productInput.sku })
        : await createShopifyProduct(productInput);
      const variant = product.variants?.nodes?.[0];
      const { error: updateError } = await supabase.from("shop_listings").update({ shopify_product_id: product.id, shopify_variant_id: variant?.id ?? null, shopify_handle: product.handle, shopify_synced_at: new Date().toISOString(), shopify_sync_status: "synced", shopify_sync_error: null }).eq("id", row.id);
      if (updateError) throw new Error(updateError.message);
      results.synced += 1;
      results.listingIds.push(row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.failed += 1;
      results.errors.push({ listingId: row.id, error: message });
      await supabase.from("shop_listings").update({ shopify_sync_status: "failed", shopify_sync_error: message.slice(0, 2000), shopify_synced_at: new Date().toISOString() }).eq("id", row.id);
    }
  }
  return results;
}
