import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, unpublishShopifyProduct, updateShopifyProduct } from "@/lib/shopify/admin";
import { isJapaneseProductDescription, isJapaneseProductTitle, isSpecificJapaneseProductTitle, localizeProductDescription, localizeProductTitle } from "@/lib/intelligence/japanese-product";
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
  if (isSpecificJapaneseProductTitle(title) && isJapaneseProductDescription(description)) {
    return { title, description };
  }
  if (!isGeminiConfigured()) {
    // Keep catalog synchronization available without a Gemini key. Use only
    // deterministic title localization and a non-claiming Japanese description;
    // never invent product specifications or benefits.
    const sourceCopy = `${title}\n${description}`;
    const fallbackTitle = localizeProductTitle(sourceCopy, title);
    if (!fallbackTitle || !isJapaneseProductTitle(fallbackTitle)) {
      throw new Error("japanese_catalog_title_localization_failed");
    }
    const fallbackDescription =
      localizeProductDescription(sourceCopy) ??
      "商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。";
    await supabaseForCopyUpdate(row.id, fallbackTitle, fallbackDescription);
    return { title: fallbackTitle, description: fallbackDescription };
  }
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
    `query ProductByHandle($query: String!) { products(first: 5, query: $query) { nodes { id handle status vendor tags variants(first: 10) { nodes { id sku price } } media(first: 10) { nodes { mediaContentType preview { image { url } } } } } } }`,
    { query: `handle:${handle}` },
  );
  // The search is fuzzy; only an exact handle match is the same product.
  return data.products.nodes.find((node) => node.handle === handle) ?? null;
}

export type ShopifySyncResult = { configured: boolean; considered: number; synced: number; failed: number; listingIds: string[]; errors: Array<{ listingId: string; error: string }> };

/** Shopify is downstream-only: canonical Sales Test Gate plus live fulfillment evidence are mandatory. */
export async function syncPublishedListingsToShopify(limit = 150, listingIds?: string[]): Promise<ShopifySyncResult> {
  if (!isShopifyConfigured()) {
    const message = "shopify_not_configured: SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN are required in production";
    return { configured: false, considered: 0, synced: 0, failed: 1, listingIds: [], errors: [{ listingId: "SYSTEM", error: message }] };
  }

  // Validate Admin API credentials before touching any listing rows. A revoked or
  // mismatched token must fail closed once per run, not mark every product failed
  // (or repeatedly attempt unpublishing) during the per-listing loop.
  try {
    await shopifyGraphQL<{ products: { nodes: Array<{ id: string }> } }>(`query ShopifyAuthPreflight { products(first: 1) { nodes { id } } }`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      configured: true,
      considered: 0,
      synced: 0,
      failed: 1,
      listingIds: [],
      errors: [{ listingId: "SYSTEM", error: `shopify_preflight_failed:${message}`.slice(0, 2000) }],
    };
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

/**
 * Why a listing may not be written to Shopify. Empty means it passes the same
 * gate, supplier, inventory and economics checks the sync applies.
 */
function blockReasons(row: Listing): string[] {
  const reasons: string[] = [];
  if (row.pipeline_stage === "BLOCKED" || row.pipeline_status === "blocked") reasons.push("pipeline_blocked");
  if (!hasGateProvenance(row)) reasons.push("sales_test_gate_not_passed");
  if (row.orderable !== true) reasons.push("not_orderable");
  if (row.tracking_available !== true) reasons.push("tracking_unavailable");
  if (!(Number(row.inventory) > 0)) reasons.push("inventory_zero_or_unknown");
  if (String(row.currency ?? "").trim().toUpperCase() !== "JPY") reasons.push("currency_not_jpy");
  if (!/^(cj|cjdropshipping)$/i.test(String(row.supplier_name ?? "").trim())) reasons.push("supplier_not_cj");
  if (!String(row.supplier_product_id ?? "").trim()) reasons.push("supplier_product_missing");
  if (!String(row.supplier_variant_id ?? "").trim()) reasons.push("supplier_variant_missing");
  if (asNumber(row.shipping_cost) === null) reasons.push("shipping_cost_unknown");
  if (asNumber(row.source_cost) === null) reasons.push("source_cost_unknown");
  if (!((asNumber(row.contribution_profit) ?? 0) > 0)) reasons.push("profit_not_positive");
  if (!((asNumber(row.contribution_margin) ?? 0) > 0)) reasons.push("margin_not_positive");
  return reasons;
}

export type ShopifySyncPreviewRow = {
  listingId: string;
  productId: string;
  eligible: boolean;
  blockReasons: string[];
  sku: string;
  supplier: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  imageOk: boolean;
  sellingPrice: number | null;
  inventory: number | null;
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  lastError: string | null;
};

/**
 * Read-only: which listings the next sync would write, with the identifiers
 * that will be sent (SKU, supplier product/variant, price, image, inventory).
 * Same query and the same checks as syncPublishedListingsToShopify.
 */
export async function previewShopifySync(limit = 150): Promise<{ considered: number; eligible: number; rows: ShopifySyncPreviewRow[]; reasonCounts: Record<string, number> }> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select("id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,supplier_name,shipping_cost,source_cost,contribution_profit,contribution_margin,shopify_product_id,shopify_variant_id,shopify_handle,shopify_sync_error")
    .or("and(published.eq.true,pipeline_stage.eq.PUBLISHED,pipeline_status.eq.published),and(published.eq.false,pipeline_stage.eq.SELECTED,pipeline_status.eq.selected),and(published.eq.false,pipeline_stage.eq.BLOCKED,shopify_product_id.not.is.null)")
    .or("shopify_sync_status.is.null,shopify_sync_status.neq.syncing")
    .order("shopify_product_id", { ascending: true, nullsFirst: true })
    .order("pipeline_updated_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 1000));
  if (error) throw new Error(error.message);
  const reasonCounts: Record<string, number> = {};
  const rows = ((data ?? []) as Array<Listing & { shopify_sync_error?: string | null }>).map((row) => {
    const reasons = blockReasons(row);
    if (typeof row.image_url !== "string" || !/^https?:\/\//i.test(row.image_url)) reasons.push("image_url_invalid");
    if (!(asNumber(row.selling_price) !== null && (asNumber(row.selling_price) ?? 0) > 0)) reasons.push("selling_price_invalid");
    for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    return {
      listingId: row.id,
      productId: row.product_id,
      eligible: reasons.length === 0,
      blockReasons: reasons,
      sku: sku(row),
      supplier: row.supplier_name,
      supplierProductId: row.supplier_product_id,
      supplierVariantId: row.supplier_variant_id,
      imageOk: typeof row.image_url === "string" && /^https?:\/\//i.test(row.image_url),
      sellingPrice: asNumber(row.selling_price),
      inventory: asNumber(row.inventory),
      shopifyProductId: row.shopify_product_id,
      shopifyVariantId: row.shopify_variant_id,
      lastError: row.shopify_sync_error ? String(row.shopify_sync_error).slice(0, 120) : null,
    };
  });
  return { considered: rows.length, eligible: rows.filter((row) => row.eligible).length, rows, reasonCounts };
}

async function syncListingRows(
  rawRows: Listing[],
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<ShopifySyncResult> {
  const rows = rawRows.map((row) => ({
    ...row,
    shopify_product_id: toShopifyGid("Product", row.shopify_product_id),
    shopify_variant_id: toShopifyGid("ProductVariant", row.shopify_variant_id),
  }));
  const candidates = rows.filter((row) => blockReasons(row).length === 0);
  const blocked = rows.filter((row) => !candidates.includes(row));
  const results: ShopifySyncResult = {
    configured: true,
    considered: rows.length,
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
      if (message === "shopify_product_not_found_for_unpublication_check") {
        // Nothing left on Shopify to sell; the listing simply stays blocked.
        await supabase.from("shop_listings").update({
          shopify_sync_status: "blocked",
          shopify_sync_error: "shopify_product_missing",
          shopify_synced_at: new Date().toISOString(),
        }).eq("id", row.id);
        continue;
      }
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
      // A stored id whose product no longer exists in Shopify is stale: fall
      // back to an exact handle match, otherwise create the product afresh.
      const existing = existingById ?? (await findByHandle(productInput.handle));

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
      if (message === "japanese_catalog_title_localization_failed" || message === "japanese_catalog_copy_invalid") {
        if (row.shopify_product_id) await unpublishShopifyProduct(String(row.shopify_product_id));
        await supabase.from("shop_listings").update({
          published: false,
          pipeline_stage: "BLOCKED",
          pipeline_status: "blocked",
          pipeline_reason: "japanese_catalog_copy_invalid",
          pipeline_updated_at: new Date().toISOString(),
          published_at: null,
          shopify_sync_status: "blocked",
          shopify_sync_error: message,
          shopify_synced_at: new Date().toISOString(),
        }).eq("id", row.id);
        continue;
      }
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
