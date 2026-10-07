import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, shopifyGraphQL, unpublishShopifyProduct, updateShopifyProduct } from "@/lib/shopify/admin";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";

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
  supplier_name: string | null;
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
  media?: { nodes: Array<{ mediaContentType: string; preview?: { image?: { url: string } | null } | null }> };
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
    `query ProductByHandle($query: String!) { products(first: 1, query: $query) { nodes { id handle status vendor tags variants(first: 10) { nodes { id sku price } } media(first: 10) { nodes { mediaContentType preview { image { url } } } } } } }`,
    { query: `handle:${handle}` },
  );
  return data.products.nodes[0] ?? null;
}

export type ShopifySyncResult = { configured: boolean; considered: number; synced: number; failed: number; listingIds: string[]; errors: Array<{ listingId: string; error: string }> };

/** Shopify is downstream-only: canonical Sales Test Gate plus live fulfillment evidence are mandatory. */
export async function syncPublishedListingsToShopify(limit = 50, listingIds?: string[]): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) return { configured: false, considered: 0, synced: 0, failed: 0, listingIds: [], errors: [] };

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select("id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,supplier_name,shopify_product_id,shopify_variant_id,shopify_handle")
    .or("and(published.eq.true,pipeline_stage.eq.PUBLISHED,pipeline_status.eq.published),and(published.eq.false,pipeline_stage.eq.SELECTED,pipeline_status.eq.selected)")
    .order("pipeline_updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  if (listingIds?.length) {
    const filtered = ((data ?? []) as Listing[]).filter((row) => listingIds.includes(String(row.id)));
    return syncListingRows(filtered, supabase);
  }


  return syncListingRows((data ?? []) as Listing[], supabase);
}

async function syncListingRows(
  rows: Listing[],
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<ShopifySyncResult> {
  const candidates = rows.filter((row) =>
    (hasPassedSalesTestGate(row) || (row.published === false && row.pipeline_stage === "SELECTED" && row.pipeline_status === "selected")) &&
    row.orderable === true &&
    row.tracking_available === true &&
    !/^(cj|cjdropshipping)$/i.test(String(row.supplier_name ?? "").trim()) &&
    isJapaneseProductTitle(row.title) &&
    Number(row.inventory) > 0,
  );
  const blocked = rows.filter((row) => !candidates.includes(row));
  const results: ShopifySyncResult = {
    configured: true,
    considered: candidates.length,
    synced: 0,
    failed: 0,
    listingIds: [],
    errors: [],
  };

  for (const row of blocked) {
    if (!row.shopify_product_id) {
      await supabase.from("shop_listings").update({
        shopify_sync_status: "blocked",
        shopify_sync_error: "sales_test_or_supply_gate_not_passed",
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
      continue;
    }
    try {
      await unpublishShopifyProduct(String(row.shopify_product_id));
      await supabase.from("shop_listings").update({
        shopify_sync_status: "blocked",
        shopify_sync_error: "sales_test_or_supply_gate_not_passed",
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.failed += 1;
      results.errors.push({ listingId: row.id, error: `unpublish_failed:${message}` });
      await supabase.from("shop_listings").update({
        shopify_sync_status: "failed",
        shopify_sync_error: `unpublish_failed:${message}`.slice(0, 2000),
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
    }
  }

  for (const row of candidates) {
    try {
      const price = asNumber(row.selling_price);
      if (price === null || price <= 0) throw new Error("selling_price_invalid");
      if (typeof row.image_url !== "string" || !/^https?:\/\//i.test(row.image_url)) throw new Error("image_url_invalid");

      const productInput = {
        title: row.title,
        descriptionHtml: html(row.description),
        handle: row.shopify_handle || row.slug,
        price,
        sku: sku(row),
      };
      const existing = (await findByHandle(productInput.handle)) ?? (row.shopify_product_id
        ? {
            id: row.shopify_product_id,
            handle: row.shopify_handle || row.slug,
            vendor: "TRACER",
            tags: ["TRACER"],
            variants: { nodes: [{ id: row.shopify_variant_id || "", sku: null, price: null }] },
            media: { nodes: [] },
          }
        : null);

      if (existing && existing.vendor && existing.vendor !== "TRACER" && !existing.tags.includes("TRACER")) {
        throw new Error("shopify_handle_owned_by_non_tracer_product");
      }

      const product = existing
        ? await updateShopifyProduct({
            productId: existing.id,
            title: productInput.title,
            descriptionHtml: productInput.descriptionHtml,
            handle: productInput.handle,
            price: productInput.price,
            variantId: existing.variants.nodes[0]?.id || null,
            sku: productInput.sku,
            imageUrl: existing.media?.nodes?.length ? null : row.image_url,
          })
        : await createShopifyProduct({ ...productInput, imageUrl: row.image_url });

      const publication = await ensureShopifyProductPublished(product.id);
      const variant = product.variants?.nodes?.[0];
      const { error: updateError } = await supabase.from("shop_listings").update({
        shopify_product_id: product.id,
        shopify_variant_id: variant?.id ?? null,
        shopify_handle: product.handle,
        shopify_synced_at: new Date().toISOString(),
        shopify_sync_status: "synced",
        shopify_sync_error: null,
        shopify_status: publication.published ? "published" : "blocked",
      }).eq("id", row.id);
      if (updateError) throw new Error(updateError.message);

      if (publication.published !== true) throw new Error("shopify_publication_not_confirmed");
      results.synced += 1;
      results.listingIds.push(row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.failed += 1;
      results.errors.push({ listingId: row.id, error: message });
      await supabase.from("shop_listings").update({
        shopify_sync_status: "failed",
        shopify_sync_error: message.slice(0, 2000),
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
    }
  }

  return results;
}
