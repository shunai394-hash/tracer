import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, unpublishShopifyProduct, updateShopifyProduct } from "@/lib/shopify/admin";
import { hasPassedSalesTestGate } from "@/lib/market/sales-test-gate";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini/client";

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
  shipping_cost?: number | string | null;
  source_cost?: number | string | null;
  contribution_profit?: number | string | null;
  contribution_margin?: number | string | null;
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

function hasGateProvenance(row: Listing): boolean {
  return Array.isArray(row.selection_reasons)
    && row.selection_reasons.some((reason) => String(reason) === "sales_test_gate_passed");
}

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

async function ensureJapaneseCopy(row: Listing): Promise<{ title: string; description: string }> {
  const title = String(row.title ?? "").trim();
  const description = String(row.description ?? title).trim();
  if (isJapaneseProductTitle(title) && /[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(description)) {
    return { title, description };
  }
  if (!isGeminiConfigured()) throw new Error("japanese_catalog_copy_requires_gemini");
  const result = await generateStructuredJson<{ title?: string; detail?: string }>({
    systemInstruction: "あなたは日本のEC商品編集者です。入力情報だけを使い、日本語の商品名と商品説明を作成してください。英語のブランド名・型番・規格は必要な場合だけ残してください。存在しない仕様や数値は追加しないでください。JSONのみ返してください。",
    prompt: JSON.stringify({ title, description }),
    timeoutMs: 12000,
  });
  const translatedTitle = String(result?.title ?? "").trim();
  const translatedDescription = String(result?.detail ?? "").trim();
  if (!isJapaneseProductTitle(translatedTitle) || !/[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(translatedDescription)) {
    throw new Error("japanese_catalog_copy_invalid");
  }
  await supabaseForCopyUpdate(row.id, translatedTitle, translatedDescription);
  return { title: translatedTitle, description: translatedDescription };
}

async function supabaseForCopyUpdate(listingId: string, title: string, description: string) {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from("shop_listings").update({
    title,
    description,
    pipeline_updated_at: new Date().toISOString(),
  }).eq("id", listingId);
  if (error) throw new Error(error.message);
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
export async function syncPublishedListingsToShopify(limit = 150, listingIds?: string[]): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) {
    const message = "shopify_not_configured: SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN are required in production";
    return { configured: false, considered: 0, synced: 0, failed: 1, listingIds: [], errors: [{ listingId: "SYSTEM", error: message }] };
  }

  const supabase = createSupabaseAdminClient();
  const baseSelect = "id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,supplier_name,shipping_cost,source_cost,contribution_profit,contribution_margin,shopify_product_id,shopify_variant_id,shopify_handle";
  let query = supabase
    .from("shop_listings")
    .select(baseSelect)
    .or("and(published.eq.true,pipeline_stage.eq.PUBLISHED,pipeline_status.eq.published),and(published.eq.false,pipeline_stage.eq.SELECTED,pipeline_status.eq.selected),and(published.eq.false,pipeline_stage.eq.BLOCKED,shopify_product_id.not.is.null)")
    .or("shopify_sync_status.is.null,shopify_sync_status.neq.syncing")
    .order("shopify_product_id", { ascending: true, nullsFirst: true })
    .order("pipeline_updated_at", { ascending: false });

  if (listingIds?.length) {
    query = query.in("id", listingIds).limit(Math.max(listingIds.length, 1));
  } else {
    query = query.limit(Math.min(Math.max(limit, 1), 150));
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return syncListingRows((data ?? []) as Listing[], supabase);
}

async function syncListingRows(
  rows: Listing[],
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<ShopifySyncResult> {
  const candidates = rows.filter((row) =>
    hasGateProvenance(row) &&
    row.orderable === true &&
    row.tracking_available === true &&
    Number(row.inventory) > 0 &&
    String(row.currency ?? "").trim().toUpperCase() === "JPY" &&
    /^CJ/i.test(String(row.supplier_name ?? "")) &&
    asNumber((row as Listing & { shipping_cost?: number | string | null }).shipping_cost) !== null &&
    asNumber((row as Listing & { source_cost?: number | string | null }).source_cost) !== null &&
    (asNumber((row as Listing & { contribution_profit?: number | string | null }).contribution_profit) ?? 0) > 0 &&
    (asNumber((row as Listing & { contribution_margin?: number | string | null }).contribution_margin) ?? 0) > 0,
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
        published: false,
        pipeline_stage: "BLOCKED",
        pipeline_status: "blocked",
        pipeline_reason: "sales_test_gate_not_passed",
        pipeline_updated_at: new Date().toISOString(),
        published_at: null,
        shopify_sync_status: "blocked",
        shopify_sync_error: "sales_test_or_supply_or_japanese_gate_not_passed",
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
        published: false,
        pipeline_stage: "BLOCKED",
        pipeline_status: "blocked",
        pipeline_reason: "sales_test_gate_unpublish_failed",
        pipeline_updated_at: new Date().toISOString(),
        published_at: null,
        shopify_sync_status: "failed",
        shopify_sync_error: `unpublish_failed:${message}`.slice(0, 2000),
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
    }
  }

  for (const row of candidates) {
    const claim = await supabase
      .from("shop_listings")
      .update({ shopify_sync_status: "syncing", shopify_sync_error: null })
      .eq("id", row.id)
      .or("shopify_sync_status.is.null,shopify_sync_status.neq.syncing")
      .select("id")
      .maybeSingle();
    if (claim.error) {
      results.failed += 1;
      results.errors.push({ listingId: row.id, error: `sync_claim_failed:${claim.error.message}` });
      continue;
    }
    if (!claim.data) continue;

    try {
      const copy = await ensureJapaneseCopy(row);
      const price = asNumber(row.selling_price);
      if (price === null || price <= 0) throw new Error("selling_price_invalid");
      if (typeof row.image_url !== "string" || !/^https?:\/\//i.test(row.image_url)) throw new Error("image_url_invalid");

      const shippingText = `日本向け配送：${asNumber(row.shipping_cost) === 0 ? "送料無料" : "送料別（仕入先確認済み）"}。配送状況は追跡可能です。`;
      const productInput = {
        title: copy.title,
        descriptionHtml: html(`${copy.description}\n\n${shippingText}`),
        handle: row.shopify_handle || row.slug,
        price,
        sku: sku(row),
      };
      const existingById = row.shopify_product_id
        ? await shopifyGraphQL<{ product: ShopifyProductNode | null }>(
            `query ProductById($id: ID!) {
              product(id: $id) {
                id handle status vendor tags
                variants(first: 10) { nodes { id sku price } }
                media(first: 10) { nodes { mediaContentType preview { image { url } } } }
              }
            }`,
            { id: row.shopify_product_id },
          ).then((result) => result.product)
        : null;
      const existing = existingById ?? (await findByHandle(productInput.handle)) ?? (row.shopify_product_id
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

      const variant = product.variants?.nodes?.[0];
      if (!variant?.id) throw new Error("shopify_variant_missing_for_inventory_sync");
      await setShopifyVariantInventory({
        variantId: variant.id,
        quantity: Number(row.inventory),
        reference: `tracer://shop-listing/${row.id}`,
      });

      const publication = await ensureShopifyProductPublished(product.id);
      const { error: updateError } = await supabase.from("shop_listings").update({
        shopify_product_id: product.id,
        shopify_variant_id: variant?.id ?? null,
        shopify_handle: product.handle,
        shopify_synced_at: new Date().toISOString(),
        shopify_sync_status: "synced",
        shopify_sync_error: null,
        ...(publication.published ? {
          published: true,
          pipeline_stage: "PUBLISHED",
          pipeline_status: "published",
          pipeline_reason: "sales_test_gate_passed",
          pipeline_updated_at: new Date().toISOString(),
        } : {}),
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
