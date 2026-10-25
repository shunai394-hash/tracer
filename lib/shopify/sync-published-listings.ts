import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, unpublishShopifyProduct, updateShopifyProduct } from "@/lib/shopify/admin";
import { isJapaneseProductDescription, isJapaneseProductTitle, isSpecificJapaneseProductTitle, localizeProductDescription, localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini/client";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { getPublishableSupplierListingStatuses } from "@/lib/catalog/canonical-supplier-identity";

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
  supplier_listing_id: string | null;
  supplier_product_id: string | null;
  supplier_variant_id: string | null;
  inventory: number | null;
  orderable: boolean;
  tracking_available: boolean;
  supplier_name: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_handle: string | null;
  shopify_sync_status: string | null;
  shopify_sync_error: string | null;
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

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

type LiveShopifyVariantState = { quantity: number; price: number; sku: string | null; hasImageMedia: boolean };

async function getLiveShopifyVariantState(variantIds: string[]): Promise<Map<string, LiveShopifyVariantState>> {
  const requestedIds = [...new Set(variantIds)];
  const ids = requestedIds.filter((id) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id));
  if (ids.length !== requestedIds.length || ids.length === 0) {
    throw new Error("shopify_live_variant_ids_invalid");
  }
  const liveState = new Map<string, LiveShopifyVariantState>();
  const batchSize = 100;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const data = await shopifyGraphQL<{ nodes: Array<{ id: string; inventoryQuantity: number | null; price: string | null; sku: string | null; product?: { media: { nodes: Array<{ mediaContentType: string }> } } | null } | null> }>(
      `query LiveVariantState($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryQuantity
            price
            sku
            product {
              media(first: 10) { nodes { mediaContentType } }
            }
          }
        }
      }`,
      { ids: batch },
    );
    for (const node of data.nodes ?? []) {
      if (!node?.id || !batch.includes(node.id)) continue;
      const quantity = asNumber(node.inventoryQuantity);
      const price = asNumber(node.price);
      if (quantity === null) throw new Error("shopify_live_stock_quantity_unknown");
      if (price === null || price <= 0) throw new Error("shopify_live_variant_price_unknown");
      liveState.set(node.id, { quantity: Math.max(0, Math.floor(quantity)), price, sku: node.sku ?? null, hasImageMedia: (node.product?.media.nodes ?? []).some((media) => media.mediaContentType === "IMAGE") });
    }
    if (batch.some((id) => !liveState.has(id))) {
      throw new Error("shopify_live_variant_response_incomplete");
    }
  }
  return liveState;
}


function html(value: string | null): string {
  if (!value) return "<p>TRACER selected product.</p>";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

function sku(listing: Listing): string {
  // BASE uses TRC-${listing.id} as its stable item identifier. Keep the same
  // channel-neutral SKU on Shopify; supplier IDs remain separate provenance.
  return `TRC-${listing.id}`.slice(0, 100);
}

async function ensureJapaneseCopy(row: Listing): Promise<{ title: string; description: string }> {
  const title = String(row.title ?? "").trim();
  const description = String(row.description ?? title).trim();
  // Workflow/status text must never survive as buyer-facing copy, even when it
  // happens to contain Japanese characters and passes the language-only check.
  const workflowDescription = /商品アイデンティティが未確定|選定対象外|観測された需要と供給データに基づいて販売テスト候補になる|sales_test_gate_not_passed|identity_pending/i.test(description);
  if (workflowDescription && isSpecificJapaneseProductTitle(title)) {
    const repairedDescription = `${title}。商品画像と販売元の最新掲載情報で仕様をご確認ください。`;
    await supabaseForCopyUpdate(row.id, title, repairedDescription);
    return { title, description: repairedDescription };
  }
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
  let result: { title?: string; detail?: string } | null = null;
  try {
    result = await generateStructuredJson<{ title?: string; detail?: string }>({
      systemInstruction: "あなたは日本のEC商品編集者です。入力情報だけを使い、日本語の商品名と商品説明を作成してください。英語のブランド名・型番・規格は必要な場合だけ残してください。存在しない仕様や数値は追加しないでください。JSONのみ返してください。",
      prompt: JSON.stringify({ title, description }),
      timeoutMs: 12000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A configured but rate-limited Gemini key must not stop otherwise valid
    // Japanese listings. Fall back to deterministic copy without inventing specs.
    if (!/429|RESOURCE_EXHAUSTED|quota exceeded|rate limit|503|UNAVAILABLE|timeout/i.test(message)) throw error;
    const sourceCopy = title + "\n" + description;
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

async function findBySku(skuValue: string): Promise<{ product: ShopifyProductNode; variantId: string } | null> {
  const data = await shopifyGraphQL<{
    productVariants: {
      nodes: Array<{ id: string; sku: string | null; product: ShopifyProductNode | null }>;
    };
  }>(
    `query ProductVariantBySku($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          sku
          product {
            id handle status vendor tags
            variants(first: 10) { nodes { id sku price } }
            media(first: 10) { nodes { mediaContentType preview { image { url } } } }
          }
        }
      }
    }`,
    { query: `sku:${skuValue}` },
  );
  const matches = (data.productVariants.nodes ?? []).filter((node) => node.sku === skuValue && node.product);
  if (matches.length > 1) throw new Error("shopify_sku_match_ambiguous");
  const match = matches[0];
  if (!match?.product) return null;
  return { product: match.product, variantId: match.id };
}

export type ShopifySyncResult = { configured: boolean; considered: number; synced: number; failed: number; listingIds: string[]; errors: Array<{ listingId: string; error: string }> };

/** Shopify is downstream-only: canonical Sales Test Gate plus live fulfillment evidence are mandatory. */
export async function syncPublishedListingsToShopify(limit = 10, listingIds?: string[]): Promise<ShopifySyncResult> {
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
  const baseSelect = "id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_listing_id,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,supplier_name,shipping_cost,source_cost,contribution_profit,contribution_margin,shopify_product_id,shopify_variant_id,shopify_handle,shopify_sync_status,shopify_sync_error";
  let query = supabase
    .from("shop_listings")
    .select(baseSelect)
    .is("archived_at", null)
    .or("published.eq.true,and(published.eq.false,supplier_product_id.not.is.null,supplier_variant_id.not.is.null)")
    .order("pipeline_updated_at", { ascending: true });

  if (listingIds?.length) {
    query = query.in("id", listingIds).limit(Math.min(listingIds.length, Math.min(Math.max(limit, 1), 15)));
  } else {
    // Fetch a bounded work pool, then exclude already-synced/blocked rows before
    // applying the per-run cap. Applying the cap in SQL first used to starve
    // later listings by repeatedly selecting the same first 150 synced rows.
    query = query.limit(1000);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Listing[];
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 15);
  let liveVariantStateById = new Map<string, LiveShopifyVariantState>();
  let liveVariantReconciliationError: string | null = null;
  if (!listingIds?.length) {
    const alreadySyncedVariantIds = rows
      .filter((row) => String(row.shopify_sync_status ?? "") === "synced" && Boolean(row.shopify_variant_id))
      .map((row) => toShopifyGid("ProductVariant", row.shopify_variant_id))
      .filter((id): id is string => typeof id === "string" && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id));
    if (alreadySyncedVariantIds.length > 0) {
      try {
        liveVariantStateById = await getLiveShopifyVariantState(alreadySyncedVariantIds);
      } catch (error) {
        liveVariantReconciliationError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const supplierStatuses = await getPublishableSupplierListingStatuses(rows.map((row) => ({
    listingId: String(row.id),
    supplierListingId: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
    productId: row.product_id == null ? null : String(row.product_id),
    supplierProductId: row.supplier_product_id == null ? null : String(row.supplier_product_id),
    supplierVariantId: row.supplier_variant_id == null ? null : String(row.supplier_variant_id),
  })));
  const nativeCjRepairIds = rows.filter((row) => row.supplier_listing_id && supplierStatuses.get(String(row.id)) === "native_cj_verified" && (row.orderable !== true || row.tracking_available !== true)).map((row) => String(row.id));
  if (nativeCjRepairIds.length > 0) {
    const now = new Date().toISOString();
    const { error: repairError } = await supabase.from("shop_listings").update({ orderable: true, tracking_available: true, pipeline_stage: "SUPPLIER_REVERIFIED", pipeline_status: "pending", pipeline_reason: "native_cj_supplier_variant_verified", pipeline_error: null, pipeline_updated_at: now, updated_at: now }).in("id", nativeCjRepairIds);
    if (repairError) throw new Error(`native_cj_listing_repair_failed:${repairError.message}`);
  }
  const eligibleRows = rows.map((row) => row.supplier_listing_id && supplierStatuses.get(String(row.id)) === "native_cj_verified" ? { ...row, orderable: true, tracking_available: true } : row);
  const actionable = listingIds?.length
    ? eligibleRows.slice(0, safeLimit)
    : eligibleRows.filter((row) => {
        const status = String(row.shopify_sync_status ?? "");
        if (status === "syncing") return false;
        const supplierEligible = Boolean(row.supplier_listing_id && supplierStatuses.has(String(row.id)));
        const listingEligible = supplierEligible && blockReasons(row).length === 0;
        if (row.published === true) {
          // Reconcile already-synced products when supplier evidence/orderability expires,
          // even if Shopify's current inventory still matches the stale TRACER quantity.
          if (!listingEligible) return true;
          if (status !== "synced") return true;
          if (liveVariantReconciliationError) return false;
          const variantId = toShopifyGid("ProductVariant", row.shopify_variant_id);
          const liveState = variantId ? liveVariantStateById.get(variantId) : undefined;
          if (!liveState) return !variantId;
          const expectedPrice = asNumber(row.selling_price);
          const staleWorkflowCopy = /商品アイデンティティが未確定|選定対象外|観測された需要と供給データに基づいて販売テスト候補になる|sales_test_gate_not_passed|identity_pending/i.test(String(row.description ?? ""));
          return staleWorkflowCopy
            || !liveState.hasImageMedia
            || liveState.quantity !== toStorefrontStockQuantity(row.inventory, getStorefrontStockCap())
            || expectedPrice === null
            || liveState.price !== expectedPrice
            || liveState.sku !== sku(row);
        }
        if (row.published === false) {
          return listingEligible;
        }
        return false;
      }).slice(0, safeLimit);

  const result = await syncListingRows(actionable, supabase);
  if (liveVariantReconciliationError) {
    result.failed += 1;
    result.errors.push({
      listingId: "SYSTEM",
      error: `shopify_live_variant_reconciliation_failed:${liveVariantReconciliationError}`.slice(0, 2000),
    });
  }
  return result;
}

/**
 * Why a listing may not be written to Shopify. Empty means it passes the
 * catalog, supplier identity, inventory, price and fulfillment checks.
 */
function blockReasons(row: Listing): string[] {
  const reasons: string[] = [];
  if (!row.supplier_product_id || !row.supplier_variant_id) reasons.push("supplier_variant_missing");
  if (row.orderable !== true) reasons.push("supplier_not_orderable");
  if (row.tracking_available !== true) reasons.push("supplier_tracking_unavailable");
  if (!isPublishableCatalogTitle(row.title)) reasons.push("catalog_title_not_publishable");
  if (!isPublishableCatalogDescription(row.description)) reasons.push("catalog_description_not_publishable");
  // Publication is a catalog operation. Do not hide a profitable, precisely
  // linked product merely because live procurement verification is pending.
  // Order-time fulfillment remains responsible for current stock and API checks.
  if (String(row.currency ?? "").trim().toUpperCase() !== "JPY") reasons.push("currency_not_jpy");
  if (asNumber(row.shipping_cost) === null) reasons.push("shipping_cost_unknown");
  if (asNumber(row.source_cost) === null) reasons.push("source_cost_unknown");
  const sellingPrice = asNumber(row.selling_price);
  const sourceCost = asNumber(row.source_cost);
  const shippingCost = asNumber(row.shipping_cost);
  const recordedProfit = asNumber(row.contribution_profit);
  const contributionProfit = recordedProfit ?? (sellingPrice !== null && sourceCost !== null && shippingCost !== null
    ? sellingPrice - sourceCost - shippingCost
    : null);
  if (contributionProfit === null) reasons.push("profit_unknown");
  else if (contributionProfit <= 0) reasons.push("profit_not_positive");
  const inventory = asNumber(row.inventory);
  if (inventory === null || inventory <= 0) reasons.push("inventory_not_positive");
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
    .select("id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_listing_id,supplier_product_id,supplier_variant_id,inventory,orderable,tracking_available,supplier_name,shipping_cost,source_cost,contribution_profit,contribution_margin,shopify_product_id,shopify_variant_id,shopify_handle,shopify_sync_error")
    .is("archived_at", null)
    .or("published.eq.true,and(published.eq.false,supplier_product_id.not.is.null,supplier_variant_id.not.is.null)")
    .or("shopify_sync_status.is.null,shopify_sync_status.neq.syncing")
    .order("shopify_product_id", { ascending: true, nullsFirst: true })
    .order("pipeline_updated_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 1000));
  if (error) throw new Error(error.message);
  const previewRows = (data ?? []) as Array<Listing & { shopify_sync_error?: string | null }>;
  const supplierStatuses = await getPublishableSupplierListingStatuses(previewRows.map((row) => ({
    listingId: String(row.id),
    supplierListingId: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
    productId: row.product_id == null ? null : String(row.product_id),
    supplierProductId: row.supplier_product_id == null ? null : String(row.supplier_product_id),
    supplierVariantId: row.supplier_variant_id == null ? null : String(row.supplier_variant_id),
  })));
  const reasonCounts: Record<string, number> = {};
  const rows = previewRows.map((rawRow) => {
    const row = rawRow;
    const reasons = blockReasons(row);
    if (!supplierStatuses.has(String(row.id))) reasons.push("supplier_identity_unlinked");
    if (typeof row.image_url !== "string" || !/^https?:\/\//i.test(row.image_url)) reasons.push("image_url_invalid");
    if (!(asNumber(row.selling_price) !== null && (asNumber(row.selling_price) ?? 0) > 0)) reasons.push("selling_price_invalid");
    if (!row.supplier_variant_id) reasons.push("supplier_variant_missing");
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
  const supplierStatuses = await getPublishableSupplierListingStatuses(rows.map((row) => ({
    listingId: String(row.id),
    supplierListingId: row.supplier_listing_id == null ? null : String(row.supplier_listing_id),
    productId: row.product_id == null ? null : String(row.product_id),
    supplierProductId: row.supplier_product_id == null ? null : String(row.supplier_product_id),
    supplierVariantId: row.supplier_variant_id == null ? null : String(row.supplier_variant_id),
  })));
  const candidates = rows.filter((row) =>
    Boolean(row.supplier_listing_id && supplierStatuses.has(String(row.id)))
    && blockReasons(row).length === 0
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
        pipeline_reason: "supplier_or_sales_gate_not_passed",
        pipeline_updated_at: new Date().toISOString(),
        published_at: null,
        shopify_sync_status: "blocked",
        shopify_sync_error: "supplier_verification_or_sales_gate_not_passed",
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
      continue;
    }
    try {
      await unpublishShopifyProduct(String(row.shopify_product_id));
      await supabase.from("shop_listings").update({
        shopify_sync_status: "blocked",
        shopify_sync_error: "shopify_unpublished_verified",
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
        pipeline_reason: "supplier_or_sales_gate_unpublish_failed",
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

      const shippingText = asNumber(row.shipping_cost) === 0
        ? "日本向け送料：仕入先の送料見積もりは0円です。最終的な配送費用は決済画面でご確認ください。"
        : "日本向け送料：仕入先の送料見積もりは商品価格の計算に反映しています。最終的な配送費用は決済画面でご確認ください。";
      let productInput = {
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
      // Recover an unpersisted create by exact SKU before relying on a handle.
      // This avoids creating a second Shopify product when the previous API
      // call succeeded but the listing-to-product mapping write did not.
      const exactSkuMatch = existingById ? null : await findBySku(productInput.sku);
      let existing = existingById ?? exactSkuMatch?.product ?? (await findByHandle(productInput.handle));
      let recoveredVariantId = !existingById && exactSkuMatch && exactSkuMatch.product.id === existing?.id
        ? exactSkuMatch.variantId
        : null;

      // Never overwrite a product owned by another vendor. Recover from a
      // stale/colliding handle by choosing a deterministic TRACER-owned handle.
      if (existing && existing.vendor !== "TRACER" && !existing.tags.includes("TRACER")) {
        const safeHandle = `tracer-${row.slug}-${row.id.slice(0, 8)}`
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 240);
        productInput = { ...productInput, handle: safeHandle };
        existing = await findByHandle(safeHandle);
        recoveredVariantId = null;
        if (existing && existing.vendor !== "TRACER" && !existing.tags.includes("TRACER")) {
          throw new Error("shopify_fallback_handle_owned_by_non_tracer_product");
        }
      }

      let product: Awaited<ReturnType<typeof createShopifyProduct>>;
      if (existing) {
        product = await updateShopifyProduct({
          productId: existing.id,
          title: productInput.title,
          descriptionHtml: productInput.descriptionHtml,
          handle: productInput.handle,
          price: productInput.price,
          // Reuse a saved variant ID only when the saved product ID was the one verified above.
          // Otherwise use an exact SKU recovery match, which admin.ts verifies against the SKU.
          variantId: existingById?.id === existing.id ? (row.shopify_variant_id || null) : recoveredVariantId,
          sku: productInput.sku,
          imageUrl: existing.media?.nodes?.some((media) => media.mediaContentType === "IMAGE") ? null : row.image_url,
        });
      } else {
        try {
          product = await createShopifyProduct({ ...productInput, imageUrl: row.image_url });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/handle.*already in use|already in use.*handle/i.test(message)) throw error;

          // A stale/fuzzy handle search can miss the exact conflicting handle.
          // The row-specific handle prevents a retry from failing on the same slug.
          const safeHandle = `tracer-${row.slug}-${row.id.slice(0, 8)}`
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 240);
          productInput = { ...productInput, handle: safeHandle };
          const exactFallback = await findByHandle(safeHandle);
          if (exactFallback && exactFallback.vendor !== "TRACER" && !exactFallback.tags.includes("TRACER")) {
            throw new Error("shopify_fallback_handle_owned_by_non_tracer_product");
          }
          product = exactFallback
            ? await updateShopifyProduct({
                productId: exactFallback.id,
                title: productInput.title,
                descriptionHtml: productInput.descriptionHtml,
                handle: productInput.handle,
                price: productInput.price,
                variantId: null,
                sku: productInput.sku,
                imageUrl: exactFallback.media?.nodes?.some((media) => media.mediaContentType === "IMAGE") ? null : row.image_url,
              })
            : await createShopifyProduct({ ...productInput, imageUrl: row.image_url });
        }
      }

      const preferredVariantId = existingById?.id === product.id
        ? row.shopify_variant_id
        : (recoveredVariantId ?? null);
      const variant = product.variants?.nodes?.find((item) => item.id === preferredVariantId)
        ?? product.variants?.nodes?.[0];
      if (!variant?.id) throw new Error("shopify_variant_missing_for_inventory_sync");
      await setShopifyVariantInventory({
        variantId: variant.id,
        quantity: toStorefrontStockQuantity(row.inventory, getStorefrontStockCap()),
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
        // Move failed rows behind untouched candidates so a transient API/AI failure
        // cannot starve the rest of the bounded sync work pool on every retry.
        pipeline_updated_at: new Date().toISOString(),
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
    }
  }

  return results;
}
