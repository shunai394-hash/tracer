import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { createBaseItem, editBaseItem, addBaseItemImage, getBasePublicShopUrl, isBaseConfigured } from "@/lib/channels/base";
import { generateStructuredJson, isGeminiConfigured } from "@/lib/ai/gemini/client";
import { isJapaneseProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { shopifyGraphQL } from "@/lib/shopify/admin";
import { getPublishableSupplierListingStatuses } from "@/lib/catalog/canonical-supplier-identity";

export type BasePublicationResult = {
  attempted: number;
  published: number;
  hidden: number;
  skipped: number;
  failed: number;
  results: Array<{ listingId: string; ok: boolean; baseItemId?: string | null; hidden?: boolean; skipped?: boolean; error?: string }>;
};

type JapaneseCatalogCopy = { title: string; detail: string; };

async function ensureJapaneseCatalogCopy(title: string, detail: string): Promise<JapaneseCatalogCopy> {
  const sourceTitle = String(title ?? "").trim();
  const sourceDetail = String(detail ?? "").trim();
  if (!isPublishableCatalogTitle(sourceTitle)) throw new Error("BASE catalog title contains workflow or disqualification text");
  if (!isPublishableCatalogDescription(sourceDetail)) throw new Error("BASE catalog description contains generic placeholder text");
  if (isJapaneseProductTitle(sourceTitle) && hasUsableJapaneseCopy(sourceDetail)) return { title: sourceTitle, detail: sourceDetail };
  if (!isGeminiConfigured()) throw new Error("BASE japanese catalog copy requires GEMINI_API_KEY");
  const result = await generateStructuredJson<JapaneseCatalogCopy>({
    systemInstruction: "あなたは日本のEC商品編集者です。入力された商品情報を日本語の販売用コピーへ変換してください。商品名と説明は必ず日本語にしてください。英語の固有名詞・型番・規格・ブランド名は必要な場合だけ残してください。存在しない仕様や数値を追加しないでください。titleは簡潔で自然な日本語の商品名、detailは購入判断に必要な特徴を読みやすい日本語でまとめてください。JSONのみ返してください。",
    prompt: JSON.stringify({ title: sourceTitle, detail: sourceDetail }),
    timeoutMs: 8_000,
  });
  const translatedTitle = String(result?.title ?? "").trim();
  const translatedDetail = String(result?.detail ?? "").trim();
  if (!isJapaneseProductTitle(translatedTitle)) throw new Error("BASE japanese catalog copy returned a non-Japanese title");
  if (!isPublishableCatalogTitle(translatedTitle)) throw new Error("BASE japanese catalog copy returned workflow or disqualification text");
  if (!isPublishableCatalogDescription(translatedDetail)) throw new Error("BASE japanese catalog copy returned generic placeholder text");
  if (!hasUsableJapaneseCopy(translatedDetail)) throw new Error("BASE japanese catalog copy returned an English-heavy description");
  return { title: translatedTitle, detail: translatedDetail };
}

function hasUsableJapaneseCopy(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.normalize("NFKC").trim();
  if (!text || !/[ぁ-んァ-ヶ一-龯々〆ヵー]/.test(text)) return false;
  const japanese = (text.match(/[ぁ-んァ-ヶ一-龯々〆ヵー]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return latin <= Math.max(12, japanese * 1.5);
}

function validHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try { const parsed = new URL(value); return parsed.protocol === "http:" || parsed.protocol === "https:"; } catch { return false; }
}

async function addBaseItemImageWithFallback(input: {
  itemId: string;
  imageUrl: string;
  shopifyProductId?: string | null;
}): Promise<void> {
  try {
    await addBaseItemImage({ itemId: input.itemId, imageNo: 1, imageUrl: input.imageUrl });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const formatRejected = /このファイル形式はご利用できません|file format.{0,30}(not supported|unsupported)/i.test(message);
    if (!formatRejected || !input.shopifyProductId || !/^gid:\/\/shopify\/Product\/\d+$/.test(input.shopifyProductId)) {
      throw error;
    }

    // BASE sometimes rejects a supplier-hosted image even when the URL ends in
    // .jpg. Shopify has already accepted and stored this listing's image, so use
    // its CDN copy as a safe format-compatible fallback instead of abandoning
    // publication or creating another BASE item.
    const result = await shopifyGraphQL<{
      product: { featuredImage: { url: string } | null } | null;
    }>(
      `query BaseCompatibleProductImage($id: ID!) {
        product(id: $id) { featuredImage { url } }
      }`,
      { id: input.shopifyProductId },
    );
    const fallbackUrl = result.product?.featuredImage?.url;
    if (!fallbackUrl || fallbackUrl === input.imageUrl || !validHttpUrl(fallbackUrl)) throw error;
    await addBaseItemImage({ itemId: input.itemId, imageNo: 1, imageUrl: fallbackUrl });
  }
}

export async function publishPublishedListingsToBase(limit = 10, listingIds?: string[]): Promise<BasePublicationResult> {
  if (!isBaseConfigured()) return { attempted: 0, published: 0, hidden: 0, skipped: 0, failed: 0, results: [] };
  if (listingIds !== undefined && listingIds.length === 0) return { attempted: 0, published: 0, hidden: 0, skipped: 0, failed: 0, results: [] };

  // Fail fast before mutating listing state if BASE OAuth is unavailable. Previously,
  // a token-refresh outage (for example HTTP 503) was recorded against every listing,
  // and the remaining publication loop continued making more failing requests.
  try {
    await getBasePublicShopUrl();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      attempted: 0, published: 0, hidden: 0, skipped: 0, failed: 1,
      results: [{ listingId: "BASE_OAUTH_PREFLIGHT", ok: false, error: message.slice(0, 500) }],
    };
  }

  const supabase = createSupabaseAdminClient();
  let query = supabase.from("shop_listings").select("id,product_id,title,description,selling_price,image_url,published,base_item_id,base_publication_status,base_publication_lease_until,base_last_error,inventory,orderable,tracking_available,shipping_cost,supplier_name,supplier_listing_id,supplier_product_id,supplier_variant_id,source_cost,contribution_profit,shopify_product_id,pipeline_stage,pipeline_status,pipeline_reason,selection_reasons").is("archived_at", null).or("supplier_name.is.null,supplier_name.neq.cj");
  if (listingIds && listingIds.length > 0) {
    // Explicit admin retries can target an exact listing regardless of its
    // current publication status.
    query = query.in("id", Array.from(new Set(listingIds)));
  } else {
    // Do not repeatedly select the same already-reconciled BASE items. That
    // starved never-published listings because existing base_item_id rows were
    // always ordered first and occupied every limited batch.
    query = query.or([
      "and(published.eq.true,base_publication_status.is.null)",
      "and(published.eq.true,base_publication_status.neq.published)",
      // Re-check stale hidden markers even when the denormalized publication
      // status says published; the canonical supplier helper below decides
      // whether this exact listing is now eligible to be visible again.
      "and(published.eq.true,base_last_error.eq.supplier_identity_unlinked_hidden)",
      "and(published.eq.false,base_item_id.not.is.null,base_publication_status.is.null,base_last_error.is.null)",
      "and(published.eq.false,base_item_id.not.is.null,base_publication_status.neq.published,base_last_error.is.null)",
      "and(published.eq.false,base_item_id.not.is.null,base_publication_status.is.null)",
      "and(published.eq.false,base_item_id.not.is.null,base_publication_status.neq.published)",
      "and(base_item_id.is.null,supplier_product_id.not.is.null,supplier_variant_id.not.is.null,published.eq.false)",
      "and(pipeline_status.eq.selected,base_item_id.is.null)",
      "and(base_item_id.is.null,base_last_error.like.base_create_id_persist_failed:*)",
    ].join(","));
  }
  const safeLimit = Math.min(15, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 10)));
  // Prefer the newest gate-passed, never-published listings. Already-hidden
  // stale BASE items are excluded above so they cannot consume every bounded
  // batch and starve fresh products waiting for their first BASE item.
  const { data: listings, error } = await query.order("created_at", { ascending: false }).limit(safeLimit);
  if (error) throw new Error(error.message);

  // Only publish rows whose exact supplier listing is currently eligible for publication.
  // Missing, unlinked, or unverified supplier evidence must be hidden on BASE.
  const supplierStatuses = await getPublishableSupplierListingStatuses((listings ?? []).map((listing) => ({
    listingId: String(listing.id),
    supplierListingId: listing.supplier_listing_id == null ? null : String(listing.supplier_listing_id),
    productId: listing.product_id == null ? null : String(listing.product_id),
    supplierProductId: listing.supplier_product_id == null ? null : String(listing.supplier_product_id),
    supplierVariantId: listing.supplier_variant_id == null ? null : String(listing.supplier_variant_id),
  })));
  const nativeCjRepairIds = (listings ?? []).filter((listing) => listing.supplier_listing_id && supplierStatuses.get(String(listing.id)) === "native_cj_verified" && (listing.orderable !== true || listing.tracking_available !== true)).map((listing) => String(listing.id));
  if (nativeCjRepairIds.length > 0) {
    const now = new Date().toISOString();
    const { error: repairError } = await supabase.from("shop_listings").update({ orderable: true, tracking_available: true, pipeline_stage: "SUPPLIER_REVERIFIED", pipeline_status: "pending", pipeline_reason: "native_cj_supplier_variant_verified", pipeline_error: null, pipeline_updated_at: now, updated_at: now }).in("id", nativeCjRepairIds);
    if (repairError) throw new Error(`native_cj_listing_repair_failed:${repairError.message}`);
  }
  const publishableListings = (listings ?? []).map((listing) => listing.supplier_listing_id && supplierStatuses.get(String(listing.id)) === "native_cj_verified" ? { ...listing, orderable: true, tracking_available: true } : listing);
  const identityUnlinkedIds = new Set<string>(publishableListings
    .filter((listing) => !listing.supplier_listing_id || !supplierStatuses.has(String(listing.id)) || listing.orderable !== true || listing.tracking_available !== true)
    .map((listing) => String(listing.id)));
  const results: BasePublicationResult["results"] = [];
  let unpublishFailed = 0;

  // Mark unlinked catalog rows blocked before any downstream publication work.
  if (identityUnlinkedIds.size > 0) {
    const now = new Date().toISOString();
    const { error: blockError } = await supabase.from("shop_listings").update({
      published: false,
      orderable: false,
      published_at: null,
      pipeline_stage: "BLOCKED",
      pipeline_status: "blocked",
      pipeline_reason: "supplier_identity_unlinked",
      pipeline_updated_at: now,
      updated_at: now,
    }).in("id", [...identityUnlinkedIds]);
    if (blockError) throw new Error(`supplier_identity_block_failed:${blockError.message}`);
  }

  // Reconcile stale BASE items, but allow supplier-linked hidden items to be republished below.
  for (const listing of publishableListings) {
    const isIdentityUnlinked = identityUnlinkedIds.has(String(listing.id));
    if (!listing.base_item_id || (listing.published === true && !isIdentityUnlinked)) continue;
    if (listing.published !== true && !isIdentityUnlinked && !["supplier_identity_unlinked_hidden", "tracer_unpublished_hidden"].includes(String(listing.base_last_error ?? ""))) continue;
    if (listing.selling_price === null) {
      unpublishFailed += 1;
      results.push({ listingId: String(listing.id), ok: false, skipped: true, error: "base_hide_price_unknown" });
      continue;
    }
    try {
      await editBaseItem({
        itemId: String(listing.base_item_id),
        title: String(listing.title ?? "").trim() || "商品情報確認中",
        detail: String(listing.description ?? listing.title ?? "").trim() || "商品情報を確認しています。",
        price: Number(listing.selling_price),
        stock: 0,
        visible: false,
      });
      await supabase.from("shop_listings").update({
        published: false,
        orderable: false,
        published_at: null,
        base_publication_status: "failed",
        base_publication_lease_until: null,
        base_last_error: isIdentityUnlinked ? "supplier_identity_unlinked_hidden" : "tracer_unpublished_hidden",
        pipeline_stage: "BLOCKED",
        pipeline_status: "blocked",
        pipeline_reason: isIdentityUnlinked ? "supplier_identity_unlinked" : "tracer_unpublished",
        pipeline_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", String(listing.id));
      results.push({ listingId: String(listing.id), ok: true, baseItemId: String(listing.base_item_id), hidden: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ listingId: String(listing.id), ok: false, error: message });
      // A rejected/expired BASE token will fail every item in this batch; stop
      // immediately to avoid hammering the API while credentials are repaired.
      if (/アクセストークンが無効|invalid_request|BASE OAuth refresh HTTP 4\d\d/i.test(message)) break;
    }
  }

  const activeListings = publishableListings.filter((listing) => !identityUnlinkedIds.has(String(listing.id)));
  // Generate Japanese copy concurrently only for listings that can remain visible.
  // spend the full serverless timeout waiting on Gemini one listing at a time.
  const copyResults = await Promise.all(activeListings.map(async (listing) => {
    const listingId = String(listing.id);
    try {
      const copy = await ensureJapaneseCatalogCopy(
        String(listing.title ?? ""),
        String(listing.description ?? listing.title ?? ""),
      );
      return { listingId, copy, error: null as string | null };
    } catch (error) {
      return {
        listingId,
        copy: null as JapaneseCatalogCopy | null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const copyByListingId = new Map(copyResults.map((item) => [item.listingId, item]));

  for (const listing of listings ?? []) {
    const listingId = String(listing.id);
    // Already-hidden BASE items were reconciled above; do not process them a
    // second time as missing-copy failures or overwrite their reconciliation reason.
    if (identityUnlinkedIds.has(listingId)) continue;
    const copyResult = copyByListingId.get(listingId);
    if (!copyResult?.copy) {
      const message = copyResult?.error ?? "japanese_catalog_copy_required";
      // Fail closed for existing BASE items too: a catalog validation failure
      // must not leave a previously visible product available for purchase.
      if (listing.base_item_id) {
        try {
          await editBaseItem({
            itemId: String(listing.base_item_id),
            title: String(listing.title ?? "").trim() || "商品情報確認中",
            detail: String(listing.description ?? listing.title ?? "").trim() || "商品情報を確認しています。",
            price: Number(listing.selling_price ?? 0),
            stock: 0,
            visible: false,
          });
        } catch (hideError) {
          const hideMessage = hideError instanceof Error ? hideError.message : String(hideError);
          await supabase.from("shop_listings").update({
            published: false,
            orderable: false,
            base_last_error: `${message};base_hide_failed:${hideMessage}`.slice(0, 2000),
            pipeline_stage: "BASE_RECONCILIATION",
            pipeline_status: "failed",
            pipeline_reason: "base_hide_failed_after_catalog_validation",
            pipeline_error: hideMessage.slice(0, 2000),
            pipeline_updated_at: new Date().toISOString(),
          }).eq("id", listingId);
          results.push({ listingId, ok: false, error: "base_hide_failed_after_catalog_validation" });
          continue;
        }
      }
      await supabase.from("shop_listings").update({
        published: false,
        orderable: false,
        base_publication_status: listing.base_item_id ? "published" : "blocked",
        base_publication_lease_until: null,
        base_last_error: message,
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "japanese_catalog_copy_required",
        pipeline_error: message,
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "japanese_catalog_copy_required" });
      continue;
    }
    const catalogCopy = copyResult.copy;
    if (catalogCopy.title !== String(listing.title ?? "").trim() || catalogCopy.detail !== String(listing.description ?? listing.title ?? "").trim()) {
      await supabase.from("shop_listings").update({ title: catalogCopy.title, description: catalogCopy.detail, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
    }
      // Do not require a separate sales-test workflow flag to publish a catalog item.
    // Concrete supplier product+variant identity, positive stock, valid price,
    // shipping cost and positive contribution profit are the meaningful checks.

    // BASE publication is a sales-channel operation, not procurement authorization.
    // Publication is based on concrete supplier linkage, stock and positive contribution profit. Fulfillment revalidates live availability at order time.
    if (!listing.supplier_product_id || !listing.supplier_variant_id) {
      await supabase.from("shop_listings").update({
        published: false,
        orderable: false,
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: "supplier_variant_identity_missing",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "supplier_variant_identity_missing" });
      continue;
    }

    const price = Number(listing.selling_price);
    if (!Number.isFinite(price) || price <= 0) {
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "selling_price_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "selling_price_invalid" });
      continue;
    }

    if (!validHttpUrl(listing.image_url)) {
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: "image_url_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: "image_url_invalid" });
      continue;
    }

    const shippingCost = listing.shipping_cost === null || listing.shipping_cost === undefined ? null : Number(listing.shipping_cost);
    if (shippingCost === null || !Number.isFinite(shippingCost) || shippingCost < 0) {
      if (listing.base_item_id) {
        try { await editBaseItem({ itemId: String(listing.base_item_id), title: catalogCopy.title, detail: catalogCopy.detail, price, stock: 0, visible: false }); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_shipping_unknown_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message }); continue;
        }
      }
      await supabase.from("shop_listings").update({ published: false, base_publication_status: listing.base_item_id ? "published" : "blocked", base_publication_lease_until: null, pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: shippingCost === null ? "shipping_unknown" : "shipping_invalid", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: shippingCost === null ? "shipping_unknown" : "shipping_invalid" }); continue;
    }

    const sourceCost = listing.source_cost === null || listing.source_cost === undefined ? null : Number(listing.source_cost);
    const recordedProfit = listing.contribution_profit === null || listing.contribution_profit === undefined ? null : Number(listing.contribution_profit);
    const contributionProfit = recordedProfit !== null && Number.isFinite(recordedProfit)
      ? recordedProfit
      : sourceCost !== null && Number.isFinite(sourceCost) && shippingCost !== null
        ? price - sourceCost - shippingCost
        : null;
    if (contributionProfit === null || !Number.isFinite(contributionProfit) || contributionProfit <= 0) {
      await supabase.from("shop_listings").update({
        published: false,
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "blocked",
        pipeline_reason: contributionProfit === null ? "profit_unknown" : "profit_not_positive",
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: contributionProfit === null ? "profit_unknown" : "profit_not_positive" });
      continue;
    }

    const availableInventory = typeof listing.inventory === "number" ? Math.floor(listing.inventory) : typeof listing.inventory === "string" && listing.inventory.trim() !== "" ? Math.floor(Number(listing.inventory)) : null;
    if (availableInventory === null || !Number.isFinite(availableInventory) || availableInventory <= 0) {
      if (listing.base_item_id) {
        try { await editBaseItem({ itemId: String(listing.base_item_id), title: catalogCopy.title, detail: catalogCopy.detail, price, stock: 0, visible: false }); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await supabase.from("shop_listings").update({ base_last_error: message, pipeline_stage: "BASE_RECONCILIATION", pipeline_status: "failed", pipeline_reason: "base_hide_failed", pipeline_error: message, pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
          results.push({ listingId, ok: false, error: message }); continue;
        }
      }
      await supabase.from("shop_listings").update({ pipeline_stage: "BASE_PUBLICATION", pipeline_status: "blocked", pipeline_reason: availableInventory === null || !Number.isFinite(availableInventory) ? "inventory_unknown" : availableInventory <= 0 ? "inventory_zero" : "supplier_not_orderable", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      results.push({ listingId, ok: false, skipped: true, error: availableInventory === null || !Number.isFinite(availableInventory) ? "inventory_unknown" : availableInventory <= 0 ? "inventory_zero" : "supplier_not_orderable" }); continue;
    }

    // Supplier warehouse inventory is not the merchant's storefront stock.
    // Keep BASE conservative and bounded just like Shopify; supplier inventory
    // is re-verified separately before any procurement attempt.
    const storefrontInventory = toStorefrontStockQuantity(
      availableInventory,
      getStorefrontStockCap(),
    );

    const leaseUntil = new Date(Date.now() + 2 * 60_000).toISOString();

    // Claim a new BASE publication atomically before creating the remote item.
    // This prevents overlapping cron invocations from creating duplicate BASE
    // products for the same TRACER listing.
    if (!listing.base_item_id) {
      const { data: claimed, error: claimError } = await supabase
        .from("shop_listings")
        .update({
          base_publication_status: "creating",
          base_publication_lease_until: leaseUntil,
          pipeline_stage: "BASE_PUBLICATION",
          pipeline_status: "publishing",
          pipeline_reason: "profitable_supplier_linked_catalog",
          pipeline_updated_at: new Date().toISOString(),
        })
        .eq("id", listingId)
        .or("published.eq.true,pipeline_status.eq.selected,published.eq.false")
        .or("base_publication_status.is.null,base_publication_status.eq.failed,base_publication_status.eq.creating")
        .or("base_publication_lease_until.is.null,base_publication_lease_until.lt." + new Date().toISOString())
        .select("id")
        .maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimed) {
        results.push({ listingId, ok: false, skipped: true, error: "base_publication_claim_lost" });
        continue;
      }
    }

    let baseItemId = listing.base_item_id ? String(listing.base_item_id) : null;
    const recoveryMarker = String(listing.base_last_error ?? "").match(/^base_create_id_persist_failed:([^:]+)(?::|$)/);
    if (!baseItemId && recoveryMarker?.[1]) baseItemId = recoveryMarker[1];

    try {
      if (!listing.base_item_id && recoveryMarker?.[1] && baseItemId) {
        // Recover the exact ID returned by BASE before any retry can create another item.
        const { error: recoveryError } = await supabase.from("shop_listings").update({
          base_item_id: baseItemId,
          base_publication_status: "creating",
          base_publication_lease_until: leaseUntil,
          base_last_error: null,
        }).eq("id", listingId);
        if (recoveryError) throw new Error(`base_create_id_recovery_failed:${recoveryError.message}`);
      }
      if (baseItemId) {
        await editBaseItem({ itemId: baseItemId, title: catalogCopy.title, detail: catalogCopy.detail, price, stock: storefrontInventory, visible: true });
      } else {
        const created = await createBaseItem({ title: catalogCopy.title, identifier: `TRC-${listingId}`, detail: catalogCopy.detail, price, stock: storefrontInventory, visible: true });
        baseItemId = String(created.item_id ?? created.item?.item_id ?? "");
        if (!baseItemId) throw new Error("BASE create response missing item_id");
        const { error: persistIdError } = await supabase.from("shop_listings").update({ base_item_id: baseItemId, base_publication_status: "creating", base_publication_lease_until: leaseUntil }).eq("id", listingId);
        if (persistIdError) throw new Error(`base_create_id_persist_failed:${baseItemId}:${persistIdError.message}`);
      }
      if (listing.image_url) await addBaseItemImageWithFallback({ itemId: baseItemId, imageUrl: listing.image_url, shopifyProductId: typeof listing.shopify_product_id === "string" ? listing.shopify_product_id : null });
      const { error: finalizeError } = await supabase.from("shop_listings").update({ published: true, published_at: new Date().toISOString(), base_item_id: baseItemId, base_published_at: new Date().toISOString(), base_publication_status: "published", base_publication_lease_until: null, base_last_error: null, pipeline_stage: "BASE_PUBLISHED", pipeline_status: "published", pipeline_reason: "profitable_supplier_linked_catalog", pipeline_updated_at: new Date().toISOString() }).eq("id", listingId);
      if (finalizeError) throw new Error(`base_publication_finalize_failed: ${finalizeError.message}`);
      results.push({ listingId, ok: true, baseItemId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const createIdPersistFailure = message.match(/^base_create_id_persist_failed:([^:]+):([\s\S]*)$/);
      const recoveryStillNeeded = !listing.base_item_id && recoveryMarker?.[1] && message.startsWith("base_create_id_recovery_failed:");
      const safeErrorMarker = createIdPersistFailure
        ? `base_create_id_persist_failed:${createIdPersistFailure[1]}:${createIdPersistFailure[2]}`.slice(0, 2000)
        : recoveryStillNeeded
          ? String(listing.base_last_error).slice(0, 2000)
          : message.slice(0, 2000);
      const { error: failureWriteError } = await supabase.from("shop_listings").update({
        base_last_error: safeErrorMarker,
        base_publication_status: "failed",
        base_publication_lease_until: null,
        pipeline_stage: "BASE_PUBLICATION",
        pipeline_status: "failed",
        pipeline_reason: createIdPersistFailure || recoveryStillNeeded ? "base_create_id_recovery_required" : "base_publish_failed",
        pipeline_error: message.slice(0, 2000),
        pipeline_updated_at: new Date().toISOString(),
      }).eq("id", listingId);
      const reportedError = failureWriteError
        ? `${message};failure_marker_write_failed:${failureWriteError.message}`
        : message;
      results.push({ listingId, ok: false, error: reportedError });
    }
  }
  return {
    attempted: listings?.length ?? 0,
    published: results.filter((r) => r.ok && r.baseItemId && !r.hidden).length,
    hidden: results.filter((r) => r.ok && r.hidden).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: unpublishFailed + results.filter((r) => !r.ok && !r.skipped).length,
    results,
  };
}
