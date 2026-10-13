import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, unpublishShopifyProduct, updateShopifyProduct } from "@/lib/shopify/admin";
import { isJapaneseProductDescription, isJapaneseProductTitle, isSpecificJapaneseProductTitle, localizeProductDescription, localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { evaluateShopListingRecord } from "@/lib/market/listing-commercial-gate";
import { mayRestoreChannelVisibility } from "@/lib/market/sales-test-gate";
import { attachSupplierCommercialEvidence } from "@/lib/market/supplier-commercial-evidence";
import { probeListingImage } from "@/lib/market/probe-listing-image";
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
  identity_method?: string | null;
  identity_confidence?: number | string | null;
  inventory: number | null;
  orderable: boolean;
  tracking_available: boolean;
  supplier_name: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_handle: string | null;
  shipping_cost?: number | string | null;
  source_cost?: number | string | null;
  source_currency?: string | null;
  fx_rate?: number | null;
  fx_observed_at?: string | null;
  supplier_listing_id?: string | null;
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
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function html(value: string | null): string {
  if (!value) return "<p>TRACER selected product.</p>";
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

function sku(listing: Listing): string {
  const source = (listing.supplier_variant_id ?? "").trim() || (listing.supplier_product_id ?? "").trim() || listing.id;
  return `TRC-${source}`.slice(0, 100);
}

export function selectShopifyVariantForSku(
  nodes: Array<{ id: string; sku: string | null }>,
  expectedSku: string,
): { variantId: string } | { error: string } {
  const expected = expectedSku.trim();
  if (!expected) return { error: "shopify_sku_missing" };
  const matches = nodes.filter((node) => (node.sku ?? "").trim() === expected);
  if (nodes.length > 1) {
    if (matches.length !== 1) return { error: matches.length === 0 ? "shopify_variant_sku_unmatched" : "shopify_variant_sku_ambiguous" };
    return { variantId: matches[0].id };
  }
  if (nodes.length === 1) {
    const remote = (nodes[0].sku ?? "").trim();
    if (remote && remote !== expected) return { error: "shopify_variant_sku_mismatch" };
    if (!nodes[0].id) return { error: "shopify_variant_missing" };
    return { variantId: nodes[0].id };
  }
  return { error: "shopify_variant_missing" };
}

function listingBlockReasons(row: Listing, imageReachable: boolean | null): string[] {
  // Inventory holds are intentionally recoverable when the durable Sales Test
  // token is still present. Re-check the same commercial gate against live
  // stock instead of treating the prior BLOCKED state as a permanent failure.
  const recoverableInventoryHold = mayRestoreChannelVisibility(row);
  const decision = evaluateShopListingRecord(
    row as unknown as Record<string, unknown>,
    imageReachable,
    { salesTestPassed: recoverableInventoryHold },
  );
  const reasons = [...decision.reasons];
  if ((row.pipeline_stage === "BLOCKED" || row.pipeline_status === "blocked") && !recoverableInventoryHold) {
    reasons.unshift("pipeline_blocked");
  }
  return Array.from(new Set(reasons));
}

const SHOPIFY_VARIANT_MAPPING_ERRORS = new Set([
  "shopify_sku_missing",
  "shopify_variant_missing",
  "shopify_variant_sku_unmatched",
  "shopify_variant_sku_ambiguous",
  "shopify_variant_sku_mismatch",
]);

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

async function findByHandle(handle: string, graphql: typeof shopifyGraphQL = shopifyGraphQL): Promise<ShopifyProductNode | null> {
  const data = await graphql<{ products: { nodes: ShopifyProductNode[] } }>(
    `query ProductByHandle($query: String!) { products(first: 5, query: $query) { nodes { id handle status vendor tags variants(first: 10) { nodes { id sku price } } media(first: 10) { nodes { mediaContentType preview { image { url } } } } } } }`,
    { query: `handle:${handle}` },
  );
  // The search is fuzzy; only an exact handle match is the same product.
  return data.products.nodes.find((node) => node.handle === handle) ?? null;
}

export type ShopifySyncResult = { configured: boolean; considered: number; synced: number; failed: number; listingIds: string[]; errors: Array<{ listingId: string; error: string }> };

export type ShopifyListingSyncDeps = {
  supabase?: ReturnType<typeof createSupabaseAdminClient>;
  probeImage?: (url: string) => Promise<boolean>;
  shopifyGraphQL?: typeof shopifyGraphQL;
  unpublishShopifyProduct?: typeof unpublishShopifyProduct;
  updateShopifyProduct?: typeof updateShopifyProduct;
  createShopifyProduct?: typeof createShopifyProduct;
  ensureShopifyProductPublished?: typeof ensureShopifyProductPublished;
  setShopifyVariantInventory?: typeof setShopifyVariantInventory;
};

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
  const baseSelect = "id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_listing_id,supplier_product_id,supplier_variant_id,identity_method,identity_confidence,inventory,orderable,tracking_available,supplier_name,shipping_cost,source_cost,contribution_profit,contribution_margin,shopify_product_id,shopify_variant_id,shopify_handle";
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
 * Preview and sync both call listingBlockReasons. Image reachability is probed
 * here so a preview rejection cannot be published by the sync.
 */
async function blockReasons(row: Listing, probeImage: (url: string) => Promise<boolean>): Promise<string[]> {
  const imageReachable = typeof row.image_url === "string" && row.image_url.trim() ? await probeImage(row.image_url) : false;
  return listingBlockReasons(row, imageReachable);
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
export async function previewShopifySync(limit = 150, deps?: ShopifyListingSyncDeps): Promise<{ considered: number; eligible: number; rows: ShopifySyncPreviewRow[]; reasonCounts: Record<string, number> }> {
  const supabase = deps?.supabase ?? createSupabaseAdminClient();
  const probeImage = deps?.probeImage ?? probeListingImage;
  const { data, error } = await supabase
    .from("shop_listings")
    .select("id,product_id,title,description,image_url,selling_price,currency,slug,published,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons,supplier_listing_id,supplier_product_id,supplier_variant_id,identity_method,identity_confidence,inventory,orderable,tracking_available,supplier_name,shipping_cost,source_cost,contribution_profit,contribution_margin,shopify_product_id,shopify_variant_id,shopify_handle,shopify_sync_error")
    .or("and(published.eq.true,pipeline_stage.eq.PUBLISHED,pipeline_status.eq.published),and(published.eq.false,pipeline_stage.eq.SELECTED,pipeline_status.eq.selected),and(published.eq.false,pipeline_stage.eq.BLOCKED,shopify_product_id.not.is.null)")
    .or("shopify_sync_status.is.null,shopify_sync_status.neq.syncing")
    .order("shopify_product_id", { ascending: true, nullsFirst: true })
    .order("pipeline_updated_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 1000));
  if (error) throw new Error(error.message);
  const enriched = await attachSupplierCommercialEvidence(supabase, (data ?? []) as Listing[]);
  const reasonCounts: Record<string, number> = {};
  const rows: ShopifySyncPreviewRow[] = [];
  for (const row of enriched as Array<Listing & { shopify_sync_error?: string | null }>) {
    const reasons = await blockReasons(row, probeImage);
    for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    rows.push({
      listingId: row.id,
      productId: row.product_id,
      eligible: reasons.length === 0,
      blockReasons: reasons,
      sku: sku(row),
      supplier: row.supplier_name,
      supplierProductId: row.supplier_product_id,
      supplierVariantId: row.supplier_variant_id,
      imageOk: reasons.includes("image_url_invalid") === false && reasons.includes("image_fetch_failed") === false && reasons.includes("image_not_confirmed") === false,
      sellingPrice: asNumber(row.selling_price),
      inventory: asNumber(row.inventory),
      shopifyProductId: row.shopify_product_id,
      shopifyVariantId: row.shopify_variant_id,
      lastError: row.shopify_sync_error ? String(row.shopify_sync_error).slice(0, 120) : null,
    });
  }
  return { considered: rows.length, eligible: rows.filter((row) => row.eligible).length, rows, reasonCounts };
}

export async function syncListingRows(
  rawRows: Listing[],
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  deps?: ShopifyListingSyncDeps,
): Promise<ShopifySyncResult> {
  const probeImage = deps?.probeImage ?? probeListingImage;
  const graphql = deps?.shopifyGraphQL ?? shopifyGraphQL;
  const unpublish = deps?.unpublishShopifyProduct ?? unpublishShopifyProduct;
  const updateProduct = deps?.updateShopifyProduct ?? updateShopifyProduct;
  const createProduct = deps?.createShopifyProduct ?? createShopifyProduct;
  const ensurePublished = deps?.ensureShopifyProductPublished ?? ensureShopifyProductPublished;
  const setInventory = deps?.setShopifyVariantInventory ?? setShopifyVariantInventory;
  const evidenced = await attachSupplierCommercialEvidence(deps?.supabase ?? supabase, rawRows);
  const rows = evidenced.map((row) => ({
    ...row,
    shopify_product_id: toShopifyGid("Product", row.shopify_product_id),
    shopify_variant_id: toShopifyGid("ProductVariant", row.shopify_variant_id),
  }));
  const reasonById = new Map<string, string[]>();
  for (const row of rows) reasonById.set(row.id, await blockReasons(row, probeImage));
  const candidates = rows.filter((row) => (reasonById.get(row.id) ?? ["sales_test_gate_not_passed"]).length === 0);
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
    const reasons = reasonById.get(row.id) ?? ["sales_test_gate_not_passed"];
    const primaryReason = reasons[0] ?? "sales_test_gate_not_passed";
    if (!row.shopify_product_id) {
      await supabase.from("shop_listings").update({
        published: false,
        pipeline_stage: "BLOCKED",
        pipeline_status: "blocked",
        pipeline_reason: primaryReason,
        pipeline_updated_at: new Date().toISOString(),
        published_at: null,
        shopify_sync_status: "blocked",
        shopify_sync_error: reasons.join(",").slice(0, 500) || "sales_test_or_supply_or_japanese_gate_not_passed",
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
      continue;
    }
    try {
      await unpublish(String(row.shopify_product_id));
      const hidden = await supabase.from("shop_listings").update({
        published: false,
        pipeline_stage: "BLOCKED",
        pipeline_status: "blocked",
        pipeline_reason: primaryReason,
        pipeline_updated_at: new Date().toISOString(),
        published_at: null,
        shopify_sync_status: "blocked",
        shopify_sync_error: reasons.join(",").slice(0, 500) || "sales_test_or_supply_gate_not_passed",
        shopify_synced_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (hidden.error) {
        const reconciliation = await supabase.from("shop_listings").update({
          shopify_sync_status: "reconciliation_required",
          shopify_sync_error: `unpublish_succeeded_db_update_failed:${hidden.error.message}`.slice(0, 2000),
          shopify_synced_at: new Date().toISOString(),
        }).eq("id", row.id);
        results.failed += 1;
        results.errors.push({ listingId: row.id, error: reconciliation.error ? "unpublish_succeeded_db_update_failed" : "unpublish_succeeded_reconciliation_recorded" });
      }
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
      // Keep the listing selected. published stays unchanged until Shopify confirms the hide.
      await supabase.from("shop_listings").update({
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

    let remoteProductIdForSafety: string | null = row.shopify_product_id;
    let remoteProductHandleForSafety: string | null = row.shopify_handle;
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
        ? await graphql<{ product: ShopifyProductNode | null }>(
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
      const existing = existingById ?? (await findByHandle(productInput.handle, graphql));

      if (existing && existing.vendor && existing.vendor !== "TRACER" && !existing.tags.includes("TRACER")) {
        throw new Error("shopify_handle_owned_by_non_tracer_product");
      }
      if (existing) {
        remoteProductIdForSafety = existing.id;
        remoteProductHandleForSafety = existing.handle;
      }

      const selectedVariant = existing ? selectShopifyVariantForSku(existing.variants?.nodes ?? [], productInput.sku) : null;
      if (selectedVariant && "error" in selectedVariant) throw new Error(selectedVariant.error);
      const product = existing
        ? await updateProduct({
            productId: existing.id,
            title: productInput.title,
            descriptionHtml: productInput.descriptionHtml,
            handle: productInput.handle,
            price: productInput.price,
            variantId: selectedVariant && "variantId" in selectedVariant ? selectedVariant.variantId : null,
            sku: productInput.sku,
            imageUrl: existing.media?.nodes?.length ? null : row.image_url,
          })
        : await createProduct({ ...productInput, imageUrl: row.image_url });
      remoteProductIdForSafety = product.id;
      remoteProductHandleForSafety = product.handle;

      const createdVariant = selectShopifyVariantForSku(product.variants?.nodes ?? [], productInput.sku);
      if ("error" in createdVariant) throw new Error(createdVariant.error);
      await setInventory({
        variantId: createdVariant.variantId,
        quantity: Number(row.inventory),
        reference: `tracer://shop-listing/${row.id}`,
      });

      const publication = await ensurePublished(product.id);
      const { error: updateError } = await supabase.from("shop_listings").update({
        shopify_product_id: product.id,
        shopify_variant_id: createdVariant.variantId,
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
      if (SHOPIFY_VARIANT_MAPPING_ERRORS.has(message)) {
        const now = new Date().toISOString();
        let unpublishError: string | null = null;
        if (remoteProductIdForSafety) {
          try {
            await unpublish(String(remoteProductIdForSafety));
          } catch (hideError) {
            unpublishError = hideError instanceof Error ? hideError.message : String(hideError);
          }
        }
        const { error: blockedStateError } = await supabase.from("shop_listings").update({
          ...(remoteProductIdForSafety ? { shopify_product_id: remoteProductIdForSafety } : {}),
          ...(remoteProductHandleForSafety ? { shopify_handle: remoteProductHandleForSafety } : {}),
          published: false,
          pipeline_stage: "BLOCKED",
          pipeline_status: "blocked",
          pipeline_reason: "shopify_variant_mapping_mismatch",
          pipeline_updated_at: now,
          published_at: null,
          shopify_sync_status: unpublishError ? "reconciliation_required" : "blocked",
          shopify_sync_error: unpublishError
            ? `${message};unpublish_failed:${unpublishError}`.slice(0, 2000)
            : message,
          shopify_synced_at: now,
        }).eq("id", row.id);
        results.failed += 1;
        results.errors.push({
          listingId: row.id,
          error: blockedStateError
            ? `variant_mapping_blocked_state_write_failed:${blockedStateError.message}`
            : unpublishError
              ? `variant_mapping_unpublish_failed:${unpublishError}`
              : message,
        });
        if (blockedStateError) {
          await supabase.from("shop_listings").update({
            shopify_sync_status: "reconciliation_required",
            shopify_sync_error: `variant_mapping_blocked_state_write_failed:${blockedStateError.message}`.slice(0, 2000),
            shopify_synced_at: now,
          }).eq("id", row.id);
        }
        continue;
      }
      if (message === "japanese_catalog_title_localization_failed" || message === "japanese_catalog_copy_invalid") {
        if (row.shopify_product_id) await unpublish(String(row.shopify_product_id));
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
