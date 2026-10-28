import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { addBaseItemImage, createBaseItem, editBaseItem, fetchBaseItemsSnapshot, getBaseItemDetail, getBasePublicShopUrl, isBaseConfigured, BASE_ITEMS_MAX_PAGES } from "@/lib/channels/base";
import { createShopifyProduct, ensureShopifyProductPublished, isShopifyConfigured, setShopifyVariantInventory, shopifyGraphQL, toShopifyGid, updateShopifyProduct } from "@/lib/shopify/admin";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";
import { isJapaneseProductTitle, localizeProductTitle } from "@/lib/intelligence/japanese-product";
import { isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { isCanonicalCjNativeId } from "@/lib/commerce/core";
import { asRelationRows } from "@/lib/commerce/relation-rows";
import { resolveBasePublicUrl } from "@/lib/commerce/base-public-url.mjs";
import { missingSaleEvidence } from "@/lib/commerce/sale-evidence";

const MIN_EXPECTED_PROFIT_JPY = Math.max(0, Number.parseInt(process.env.TRACER_MIN_EXPECTED_PROFIT_JPY ?? "2500", 10) || 2500);

type Channel = "base" | "shopify";
type SupplierOfferRow = { id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; supplier_url: string | null; currency: string; unit_cost: number; shipping_cost: number; raw_data: Record<string, unknown> | null; inventory: number; ship_to: string; tracking_supported: boolean; source_status: string; last_checked_at: string | null };
type CommercePriceRow = { supplier_offer_id: string; calculated_at: string; currency: string; selling_price: number; expected_profit: number; fee_amount: number; margin_rate: number };
type Candidate = {
  id: string; source_variant_key: string; title_ja: string; sku: string | null;
  commerce_products: { id: string; source_key: string; title_ja: string; description_ja: string; image_url: string | null; active: boolean; metadata?: Record<string, unknown> | null };
  supplier_offers: SupplierOfferRow[] | SupplierOfferRow | null;
  commerce_prices: CommercePriceRow[] | CommercePriceRow | null;
};

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; }
}
function safeSlug(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "tracer-item";
}

function shippingInclusiveDescription(description: string): string {
  // Remove legacy supplier copy that tells customers to pay freight separately.
  // The canonical JPY selling price already includes supplier shipping cost.
  const cleaned = description
    .replace(/[^。！？\n]*(?:送料別|送料別途|送料込み|送料無料|送料は商品価格に含まれています)[^。！？\n]*[。！？]?/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [cleaned, "送料込み・送料無料。日本向け送料は商品価格に含まれています。"]
    .filter(Boolean)
    .join("\n\n");
}

async function addBaseImageWithFormatFallback(input: {
  db: ReturnType<typeof createSupabaseAdminClient>;
  variantId: string;
  itemId: string;
  imageUrl: string;
}): Promise<void> {
  try {
    await addBaseItemImage({ itemId: input.itemId, imageNo: 1, imageUrl: input.imageUrl });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/このファイル形式はご利用できません|file format.{0,30}(not supported|unsupported)/i.test(message)) throw error;
    // BASE can reject a supplier-hosted image despite a URL ending in .jpg.
    // If this variant already has a Shopify product, reuse Shopify's accepted CDN
    // image. Never create a second listing or silently suppress other upload errors.
    const { data: shopifyListing, error: listingError } = await input.db.from("channel_listings")
      .select("external_product_id")
      .eq("variant_id", input.variantId)
      .eq("channel", "shopify")
      .not("external_product_id", "is", null)
      .maybeSingle();
    if (listingError || !shopifyListing?.external_product_id) throw error;
    const shopifyProductId = toShopifyGid("Product", String(shopifyListing.external_product_id));
    if (!shopifyProductId) throw error;
    const result = await shopifyGraphQL<{
      product: { featuredImage: { url: string } | null } | null;
    }>(
      `query BaseCompatibleProductImage($id: ID!) { product(id: $id) { featuredImage { url } } }`,
      { id: shopifyProductId },
    );
    const fallbackUrl = result.product?.featuredImage?.url;
    if (!fallbackUrl || fallbackUrl === input.imageUrl || !safeUrl(fallbackUrl)) throw error;
    await addBaseItemImage({ itemId: input.itemId, imageNo: 1, imageUrl: fallbackUrl });
  }
}

async function unpublishUnfulfillableListings(channel: Channel, db: ReturnType<typeof createSupabaseAdminClient>) {
  const result = { checked: 0, unpublished: 0, failed: 0, errors: [] as string[] };
  const { data: listings, error } = await db.from("channel_listings")
    .select("id,variant_id,external_product_id,external_variant_id,status,last_error,last_synced_at")
    .eq("channel", channel)
    .or("status.eq.published,last_error.like.supplier_offer_not_fulfillable%,last_error.like.supplier_offer_no_longer_fulfillable%,last_error.like.supplier_offer_disable_failed%")
    .not("external_product_id", "is", null)
    .order("last_synced_at", { ascending: true, nullsFirst: true }).limit(5);
  if (error) throw new Error("stale_listing_read_failed:" + error.message);

  // Reconcile previously published listings whose safety stop failed or whose
  // DB state changed before external visibility was verified. Only explicit
  // supplier-safety error prefixes are eligible outside the published state.
  const checkableListings = (listings ?? []).filter((listing) =>
    listing.status === "published" ||
    String(listing.last_error ?? "").startsWith("supplier_offer_not_fulfillable:") ||
    String(listing.last_error ?? "").startsWith("supplier_offer_no_longer_fulfillable:") ||
    String(listing.last_error ?? "").startsWith("supplier_offer_disable_failed:")
  );
  result.checked = checkableListings.length;
  const variantIds = [...new Set(checkableListings.map((listing) => String(listing.variant_id)).filter(Boolean))];
  if (variantIds.length === 0) return result;

  // Batch all reads before the external unpublish loop. The old per-listing pattern
  // made 1,000+ sequential Supabase requests for a 500-listing audit and timed out
  // before it could publish new products.
  const [pricesRead, offersRead, variantsRead] = await Promise.all([
    db.from("commerce_prices")
      .select("variant_id,supplier_offer_id,currency,selling_price,expected_profit,margin_rate,calculated_at")
      .in("variant_id", variantIds)
      .order("calculated_at", { ascending: false }),
    db.from("supplier_offers")
      .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,unit_cost,shipping_cost,raw_data,inventory,source_status,tracking_supported,ship_to,last_checked_at")
      .in("variant_id", variantIds)
      .order("last_checked_at", { ascending: false }),
      db.from("commerce_variants")
      .select("id,sku,title_ja,commerce_products!inner(title_ja,description_ja)")
      .in("id", variantIds),
  ]);
  if (pricesRead.error) throw new Error("stale_price_batch_read_failed:" + pricesRead.error.message);
  if (offersRead.error) throw new Error("stale_supplier_offer_batch_read_failed:" + offersRead.error.message);
  if (variantsRead.error) throw new Error("stale_variant_batch_read_failed:" + variantsRead.error.message);

  type StalePrice = { variant_id: string; supplier_offer_id: string | null; currency: string; selling_price: number; expected_profit: number; margin_rate: number; calculated_at: string | null };
  type StaleOffer = { id: string; variant_id: string; supplier_code: string; supplier_product_id: string; supplier_variant_id: string; unit_cost: number; shipping_cost: number; raw_data: Record<string, unknown> | null; inventory: number; source_status: string; tracking_supported: boolean; ship_to: string; last_checked_at: string | null };
  type StaleVariant = { id: string; sku: string | null; title_ja: string | null; commerce_products: { title_ja?: string | null; description_ja?: string | null } | Array<{ title_ja?: string | null; description_ja?: string | null }> | null };
  const pricesByVariant = new Map<string, StalePrice[]>();
  for (const price of (pricesRead.data ?? []) as StalePrice[]) {
    const rows = pricesByVariant.get(price.variant_id) ?? [];
    rows.push(price);
    pricesByVariant.set(price.variant_id, rows);
  }
  const offersByVariant = new Map<string, StaleOffer[]>();
  for (const offer of (offersRead.data ?? []) as StaleOffer[]) {
    const rows = offersByVariant.get(offer.variant_id) ?? [];
    rows.push(offer);
    offersByVariant.set(offer.variant_id, rows);
  }
  const variantsById = new Map(((variantsRead.data ?? []) as StaleVariant[]).map((variant) => [variant.id, variant]));

  for (const listing of checkableListings) {
    try {
      const prices = pricesByVariant.get(String(listing.variant_id)) ?? [];
      const offers = offersByVariant.get(String(listing.variant_id)) ?? [];
      const variantForEvidence = variantsById.get(String(listing.variant_id));
      const evaluated = offers.map((offer) => {
        const price = prices.find((candidate) => candidate.supplier_offer_id === offer.id) ?? null;
        const raw = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data) ? offer.raw_data : {};
        // Evidence age is recorded for auditing, but must not by itself delist a product.
        const stockKnown = raw.stockKnown === true || (raw.stockKnown === undefined && offer.source_status === "verified");
        const shippingKnown = raw.shippingKnown === true ||
          (raw.shippingKnown === undefined && raw.shippingEstimated !== true && offer.source_status === "verified" && Number(offer.shipping_cost) > 0);
        const nativeIdsValid = offer.supplier_code !== "cj" ||
          (isCanonicalCjNativeId(offer.supplier_product_id) && isCanonicalCjNativeId(offer.supplier_variant_id));
        // A stored price is eligible based on its actual JPY/profit/margin values, not age alone.
        const missing = missingSaleEvidence({
          supplierCode: offer.supplier_code,
          supplierProductId: nativeIdsValid ? offer.supplier_product_id : null,
          supplierVariantId: nativeIdsValid ? offer.supplier_variant_id : null,
          variantSku: variantForEvidence?.sku,
          sourceStatus: offer.source_status,
          stockKnown,
          inventory: Number(offer.inventory),
          unitCost: Number(offer.unit_cost),
          shippingKnown,
          shipTo: offer.ship_to,
          trackingSupported: offer.tracking_supported === true,
           currency: price?.currency,
          sellingPrice: Number(price?.selling_price),
          expectedProfit: Number(price?.expected_profit),
        });
         if (!price || Number(price.margin_rate) < 0.5 || Number(price.expected_profit) < MIN_EXPECTED_PROFIT_JPY) missing.push("profit_below_minimum_or_margin");
        return { offer, price, missing, nativeIdsValid };
      }).sort((a, b) => a.missing.length - b.missing.length);
      const best = evaluated[0] ?? null;
      if (best && best.missing.length === 0) {
        const checkedAt = new Date().toISOString();
        const { error: markCheckedError } = await db.from("channel_listings").update({
          status: "pending",
          last_synced_at: checkedAt,
          updated_at: checkedAt,
          last_error: null,
        }).eq("id", listing.id);
        if (markCheckedError) throw new Error("stale_listing_check_timestamp_failed:" + markCheckedError.message);
        continue;
      }

      const offer = best?.offer ?? null;
      const price = best?.price ?? null;
      const reason = best
        ? [...best.missing, ...(best.nativeIdsValid ? [] : ["supplier_native_ids_invalid"])].join(",")
        : "supplier,identity,variant,stock,cost,domestic_shipping,profit,verification";

      const variant = variantsById.get(String(listing.variant_id));
      const product = asRelationRows(variant?.commerce_products)[0] ?? null;
      const title = String(variant?.title_ja || product?.title_ja || "TRACER商品");
      const detail = String(product?.description_ja || title);
      if (channel === "base") {
        const itemId = String(listing.external_product_id);
        await editBaseItem({
          itemId, title, detail,
          price: Math.min(100_000_000, Math.max(50, Math.round(Number(price?.selling_price) || 50))),
          stock: 0, visible: false,
        });
        const readback = await getBaseItemDetail(itemId);
        const hidden = readback.visible === false || readback.visible === 0 || readback.visible === "0";
        const stock = Number(readback.stock);
        if (!hidden || !Number.isFinite(stock) || stock !== 0) {
          throw new Error("base_unpublish_readback_mismatch:visible=" + String(readback.visible) + ":stock=" + String(readback.stock));
        }
      } else {
        const productId = toShopifyGid("Product", String(listing.external_product_id));
        if (!productId) throw new Error("shopify_product_id_missing");
        const updated = await shopifyGraphQL<{
          productUpdate: { product: { id: string; status: string } | null; userErrors: Array<{ message: string }> };
        }>(
          "mutation TracerHideUnfulfillable($input: ProductUpdateInput!) { productUpdate(product: $input) { product { id status } userErrors { message } } }",
          { input: { id: productId, status: "DRAFT" } },
        );
        if (updated.productUpdate.userErrors.length || !updated.productUpdate.product) {
          throw new Error("shopify_unpublish_failed:" + (updated.productUpdate.userErrors.map((x) => x.message).join("; ") || "product_missing"));
        }
        if (updated.productUpdate.product.status !== "DRAFT") {
          throw new Error("shopify_unpublish_readback_mismatch:status=" + String(updated.productUpdate.product.status));
        }
        if (!listing.external_variant_id) throw new Error("shopify_variant_id_missing_for_zero_stock");
        try {
          await setShopifyVariantInventory({
            variantId: String(listing.external_variant_id), quantity: 0,
            reference: "stale-supplier-offer:" + String(listing.variant_id),
          });
        } catch (inventoryError) {
          throw new Error("shopify_inventory_zero_failed:" + (inventoryError instanceof Error ? inventoryError.message : String(inventoryError)).slice(0, 120));
        }
      }
      const { error: saveError } = await db.from("channel_listings").update({
        status: "error",
        last_error: "supplier_offer_no_longer_fulfillable:" + reason,
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", listing.id);
      if (saveError) throw new Error("stale_listing_state_save_failed:" + saveError.message);
      result.unpublished++;
    } catch (error) {
      result.failed++;
      result.errors.push(String(listing.id) + ":" + (error instanceof Error ? error.message : String(error)).slice(0, 180));
    }
  }
  return result;
}

export async function syncCommerceListings(channel: Channel, limit = 10, onlyUnpublished = true, variantIds?: string[]) {
  // Storefront publication is independent of supplier purchasing. Only the paid-order
  // procurement path is gated by liveOrdering; a sandbox proof must not block listings.
  if (channel === "base" && !isBaseConfigured()) throw new Error("base_oauth_not_configured");
  if (channel === "shopify" && !isShopifyConfigured()) throw new Error("shopify_not_configured");
  const db = createSupabaseAdminClient();
  let basePublicShopUrl = process.env.BASE_PUBLIC_SHOP_URL?.trim() ?? "";
  if (channel === "base" && !basePublicShopUrl) {
    try {
      basePublicShopUrl = (await getBasePublicShopUrl()) ?? "";
    } catch (error) {
      // A missing public URL must never block publication; it only omits the outbound URL in our dashboard.
      console.warn("[commerce-publish] BASE public shop URL lookup failed", {
        error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      });
    }
  }
  // A published listing stays purchasable only when supplier identity, stock, Japan shipping, tracking and profit are all present. Anything missing is removed from sale without deleting the product.
  const staleListings = { checked: 0, unpublished: 0, failed: 0, errors: [] as string[] };
  // Hide listings with missing/invalid supplier identity before publishing the next batch.
  const identityCleanup = await unpublishUnfulfillableListings(channel, db);
  staleListings.checked += identityCleanup.checked;
  staleListings.unpublished += identityCleanup.unpublished;
  staleListings.failed += identityCleanup.failed;
  staleListings.errors.push(...identityCleanup.errors);
  const candidateSelect = "id,source_variant_key,title_ja,sku,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,active,metadata),supplier_offers(id,supplier_code,supplier_product_id,supplier_variant_id,supplier_url,currency,unit_cost,shipping_cost,raw_data,inventory,ship_to,tracking_supported,source_status,last_checked_at),commerce_prices(supplier_offer_id,calculated_at,currency,selling_price,expected_profit,fee_amount,margin_rate)";
  let candidateQuery = db.from("commerce_variants")
    .select(candidateSelect)
    .eq("commerce_products.active", true);
  if (variantIds?.length) candidateQuery = candidateQuery.in("id", [...new Set(variantIds)]);

  // Do not let the newest 1,000 catalog updates starve older storefront recovery
  // rows. Read a small, bounded queue of pending/safety-error listings first, then
  // merge it ahead of the broad discovery batch. Explicit variantIds remain exact.
  let priorityCandidates: Candidate[] = [];
  if (!variantIds?.length) {
    const { data: priorityListings, error: priorityListingsError } = await db.from("channel_listings")
      .select("variant_id,last_synced_at")
      .eq("channel", channel)
      .or("status.eq.pending,last_error.like.supplier_offer_not_fulfillable%,last_error.eq.japanese_product_title_invalid")
      .order("last_synced_at", { ascending: true, nullsFirst: true })
      .limit(100);
    if (priorityListingsError) throw new Error("commerce_recovery_queue_read_failed:" + priorityListingsError.message);
    const priorityIds = [...new Set((priorityListings ?? []).map((row) => String(row.variant_id ?? "")).filter(Boolean))];
    if (priorityIds.length) {
      const { data: priorityData, error: priorityError } = await db.from("commerce_variants")
        .select(candidateSelect)
        .eq("commerce_products.active", true)
        .in("id", priorityIds)
        .order("updated_at", { ascending: true })
        .limit(100);
      if (priorityError) throw new Error("commerce_recovery_candidates_read_failed:" + priorityError.message);
      priorityCandidates = (priorityData ?? []) as unknown as Candidate[];
    }
  }
  const { data, error } = await candidateQuery.order("updated_at", { ascending: false }).limit(1000);
  if (error) throw new Error("commerce_candidates_read_failed:" + error.message);
  const seenCandidateIds = new Set<string>();
  const allCandidates = [...priorityCandidates, ...((data ?? []) as unknown as Candidate[])]
    .filter((candidate) => {
      if (seenCandidateIds.has(candidate.id)) return false;
      seenCandidateIds.add(candidate.id);
      return true;
    });
  // PostgREST GET URLs can exceed gateway limits when .in() contains the
  // entire 1,000-row candidate batch. Read listing state in small bounded chunks.
  const candidateVariantIds = [...new Set(allCandidates.map((row) => row.id))];
  const listingStates: Array<{
    variant_id: string; status: string; last_synced_at: string | null;
    external_product_id: string | null; external_variant_id: string | null; last_error: string | null;
  }> = [];
  for (let offset = 0; offset < candidateVariantIds.length; offset += 100) {
    const ids = candidateVariantIds.slice(offset, offset + 100);
    const { data: batch, error: stateError } = await db.from("channel_listings")
      .select("variant_id,status,last_synced_at,external_product_id,external_variant_id,last_error")
      .eq("channel", channel)
      .in("variant_id", ids);
    if (stateError) throw new Error("commerce_listing_state_read_failed:batch=" +
      Math.floor(offset / 100) + ":" + stateError.message);
    listingStates.push(...((batch ?? []) as typeof listingStates));
  }
  const stateByVariant = new Map(listingStates.map((row) => [String(row.variant_id), row]));
  const rank = (row: Candidate) => {
    const state = stateByVariant.get(row.id);
    if (!state) return 0;
    if (state.status === "pending") return 1;
    if (state.status === "error") return 2;
    return 3;
  };
  const sortedCandidates = [...allCandidates].sort((a, b) => {
    const priority = rank(a) - rank(b);
    if (priority !== 0) return priority;
    const aTime = stateByVariant.get(a.id)?.last_synced_at ? Date.parse(String(stateByVariant.get(a.id)?.last_synced_at)) : 0;
    const bTime = stateByVariant.get(b.id)?.last_synced_at ? Date.parse(String(stateByVariant.get(b.id)?.last_synced_at)) : 0;
    return aTime - bTime;
  });
  // Recovery runs should publish missing/pending/error listings only. Reprocessing
  // already-published products repeatedly resets their status to pending and wastes
  // the channel API budget without increasing the public catalog.
  const candidatesToProcess = onlyUnpublished
    ? sortedCandidates.filter((candidate) => {
        const state = stateByVariant.get(candidate.id);
        if (state?.status !== "published") return true;
        const offers = asRelationRows(candidate.supplier_offers);
        const prices = asRelationRows(candidate.commerce_prices).sort((a, b) =>
          Date.parse(String(b.calculated_at ?? "")) - Date.parse(String(a.calculated_at ?? "")),
        );
        const price = prices[0];
        const offer = offers.find((item) => String(item.id) === String(price?.supplier_offer_id ?? ""));
        const data = offer?.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
          ? offer.raw_data as Record<string, unknown> : {};
         const shippingKnown = Boolean(offer && data.shippingEstimated !== true && (
          data.shippingKnown === true ||
          (data.shippingKnown === undefined && offer.source_status === "verified" &&
            Number.isFinite(Number(offer.shipping_cost)) && Number(offer.shipping_cost) > 0)
        ));
        const stockKnown = data.stockKnown === true ||
          (data.stockKnown === undefined && offer?.source_status === "verified");
        const saleable = Boolean(offer && price && offer.source_status === "verified" &&
          shippingKnown && stockKnown && offer.ship_to === "JP" &&
          offer.tracking_supported === true && Number(offer.inventory) > 0 &&
          price.currency === "JPY" && Number(price.selling_price) > 0 &&
          Number(price.expected_profit) >= MIN_EXPECTED_PROFIT_JPY && Number(price.margin_rate) >= 0.5);
        // Recovery may revisit a published item only when supplier evidence says it
        // is no longer genuinely purchasable, so it can be hidden rather than skipped.
        return !saleable;
      })
    : sortedCandidates;
  const candidates = candidatesToProcess.slice(0, Math.min(100, Math.max(1, Math.floor(limit))));
  type BaseSnapshotItem = Record<string, unknown>;
  let baseSnapshotItems: BaseSnapshotItem[] | null = null;
  let baseSnapshotFailure: string | null = null;
  // A full 5,000-item BASE scan is only needed to recover an interrupted
  // create for a listing that already existed in our ledger. A brand-new variant
  // has no previous external item to recover, so create it directly with its stable SKU.
  if (channel === "base" && candidates.some((candidate) => {
    const state = stateByVariant.get(candidate.id);
    return Boolean(state && !state.external_product_id);
  })) {
    try {
      const snapshot = await fetchBaseItemsSnapshot({ itemPageLimit: 100, itemMaxPages: BASE_ITEMS_MAX_PAGES });
      if (snapshot.complete !== true || !Array.isArray(snapshot.items)) throw new Error("base_create_recovery_snapshot_incomplete");
      baseSnapshotItems = snapshot.items as unknown as BaseSnapshotItem[];
    } catch (error) {
      baseSnapshotFailure = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    }
  }
  const baseItemsById = new Map<string, BaseSnapshotItem>();
  for (const item of baseSnapshotItems ?? []) {
    const id = String(item.item_id ?? "").trim();
    if (id) baseItemsById.set(id, item);
  }
  const results: Array<{ variantId: string; ok: boolean; externalId?: string; externalVariantId?: string; expectedPrice?: number; error?: string; missingEvidence?: string[]; action?: "published" | "unpublished" }> = [];
  for (const candidate of candidates) {
    const product = candidate.commerce_products;
    const validOffers = asRelationRows(candidate.supplier_offers)
      .filter((x) => {
        const nativeIdsValid = x.supplier_code !== "cj" ||
          (isCanonicalCjNativeId(x.supplier_product_id) && isCanonicalCjNativeId(x.supplier_variant_id));
        const unitCostKnown = Number.isFinite(Number(x.unit_cost)) && Number(x.unit_cost) > 0;
        const shippingKnown = x.raw_data?.shippingKnown === true ||
          (x.raw_data?.shippingKnown === undefined && x.raw_data?.shippingEstimated !== true &&
            x.source_status === "verified" && Number.isFinite(Number(x.shipping_cost)) && Number(x.shipping_cost) > 0);
        return Boolean(x.supplier_product_id && x.supplier_variant_id && nativeIdsValid && unitCostKnown && shippingKnown);
      });
    const allOffers = asRelationRows(candidate.supplier_offers);
    const currentPriceRows = asRelationRows(candidate.commerce_prices).sort((a, b) =>
      Date.parse(String(b.calculated_at ?? "")) - Date.parse(String(a.calculated_at ?? "")),
    );
    const currentCanonicalPrice = currentPriceRows[0];
    const currentPriceOfferId = String(currentCanonicalPrice?.supplier_offer_id ?? "");
    const currentPriceOffer = currentPriceOfferId
      ? validOffers.find((candidateOffer) => String(candidateOffer.id) === currentPriceOfferId)
      : undefined;
    const price = currentCanonicalPrice && currentPriceOffer &&
      currentCanonicalPrice.currency === "JPY" &&
      Number(currentCanonicalPrice.selling_price) > 0 &&
      Number(currentCanonicalPrice.expected_profit) >= MIN_EXPECTED_PROFIT_JPY &&
      Number(currentCanonicalPrice.margin_rate) >= 0.5
      ? currentCanonicalPrice
      : undefined;
    const offer = price ? currentPriceOffer : undefined;
    const imageUrl = safeUrl(product.image_url);
    const sourceTitle = typeof product.metadata?.sourceTitle === "string" ? product.metadata.sourceTitle : typeof product.metadata?.source_title === "string" ? product.metadata.source_title : typeof product.metadata?.originalTitle === "string" ? product.metadata.originalTitle : null;
    const localizedSourceTitle = sourceTitle ? localizeProductTitle(sourceTitle) : null;
    // Japanese text alone is not enough: category placeholders such as "ヘアケアアイテム"
    // pass the language check but are rejected by the catalog title quality gate.
    // Prefer a source-grounded localized title when stored titles are generic.
    // Storefront titles must be fully localized, not merely contain a few Japanese characters.
    // If a stored title contains English words, require a source-grounded Japanese mapping;
    // never republish mixed-language titles as customer-facing copy.
    const containsEnglishWords = (value: unknown) => typeof value === "string" && /[A-Za-z]{2,}/.test(value.replace(/\b(?:PU|PC|USB|LED|UV|A4|Type-C|iPhone|Huawei|PHOERA)\b/gi, ""));
    const localizedTitleIsPublishable = Boolean(localizedSourceTitle && isPublishableCatalogTitle(localizedSourceTitle) &&
      isJapaneseProductTitle(localizedSourceTitle) && !containsEnglishWords(localizedSourceTitle));
    const title = localizedTitleIsPublishable
      ? String(localizedSourceTitle).trim()
      : !containsEnglishWords(candidate.title_ja) && isPublishableCatalogTitle(candidate.title_ja) && isJapaneseProductTitle(candidate.title_ja)
        ? candidate.title_ja.trim()
        : !containsEnglishWords(product.title_ja) && isPublishableCatalogTitle(product.title_ja) && isJapaneseProductTitle(product.title_ja)
          ? product.title_ja.trim()
          : "";
    const rawOffer = currentPriceOfferId
      ? allOffers.find((candidateOffer) => String(candidateOffer.id) === currentPriceOfferId) ?? null
      : null;
    const preflightRawOfferData = rawOffer?.raw_data && typeof rawOffer.raw_data === "object" && !Array.isArray(rawOffer.raw_data)
      ? rawOffer.raw_data as Record<string, unknown>
      : {};
    const preflightShippingKnown =
      (Number.isFinite(Number(rawOffer?.shipping_cost)) && Number(rawOffer?.shipping_cost) > 0) &&
      (preflightRawOfferData.shippingKnown === true ||
        (preflightRawOfferData.shippingKnown === undefined && preflightRawOfferData.shippingEstimated !== true && rawOffer?.source_status === "verified"));
    const preflightStockKnown = preflightRawOfferData.stockKnown === true ||
      (preflightRawOfferData.stockKnown === undefined && rawOffer?.source_status === "verified");
     const supplierEvidenceUnverified = !rawOffer || rawOffer.source_status !== "verified" ||
      !preflightShippingKnown || !preflightStockKnown ||
      rawOffer.tracking_supported !== true || rawOffer.ship_to !== "JP" ||
      !Number.isFinite(Number(rawOffer.inventory)) || Number(rawOffer.inventory) <= 0;
    const currentState = stateByVariant.get(candidate.id);
    // Never republish a previously-created item unless supplier identity, known positive
    // stock, Japan shipping, tracking, and positive-margin pricing are all evidenced.
    // A stale timestamp alone is not a reason to delist; the order flow must recheck stock.
    if (currentState?.external_product_id && supplierEvidenceUnverified) {
      const missing = rawOffer ? missingSaleEvidence({
        supplierCode: rawOffer.supplier_code,
        supplierProductId: rawOffer.supplier_product_id,
        supplierVariantId: rawOffer.supplier_variant_id,
        variantSku: candidate.sku,
        sourceStatus: rawOffer.source_status,
        stockKnown: preflightStockKnown,
        inventory: Number(rawOffer.inventory),
        unitCost: Number(rawOffer.unit_cost),
        shippingKnown: preflightShippingKnown,
        shipTo: rawOffer.ship_to,
        trackingSupported: rawOffer.tracking_supported === true,
         currency: currentCanonicalPrice?.currency,
        sellingPrice: Number(currentCanonicalPrice?.selling_price),
        expectedProfit: Number(currentCanonicalPrice?.expected_profit),
      }) : ["supplier", "identity", "variant", "stock", "cost", "domestic_shipping", "profit"];
      const reason = missing.join(",") || "supplier_offer_invalid";
      const nowIso = new Date().toISOString();
      try {
        const fallbackPrice = Math.min(100_000_000, Math.max(50, Math.round(Number(asRelationRows(candidate.commerce_prices)[0]?.selling_price) || 50)));
        if (channel === "base") {
          await editBaseItem({
            itemId: String(currentState.external_product_id),
            title,
            detail: String(product.description_ja || title) + "\n\n仕入先の在庫・日本向け送料を確認中のため、現在購入できません。",
            price: fallbackPrice,
            stock: 0,
            visible: false,
          });
        } else {
          const productId = toShopifyGid("Product", String(currentState.external_product_id));
          if (!productId) throw new Error("shopify_product_id_missing");
          const updated = await shopifyGraphQL<{
            productUpdate: { product: { id: string; status: string } | null; userErrors: Array<{ message: string }> };
          }>(
            "mutation TracerHideUnfulfillable($input: ProductUpdateInput!) { productUpdate(product: $input) { product { id status } userErrors { message } } }",
            { input: { id: productId, status: "DRAFT" } },
          );
          if (updated.productUpdate.userErrors.length || !updated.productUpdate.product) {
            throw new Error("shopify_unpublish_failed:" + (updated.productUpdate.userErrors.map((x) => x.message).join("; ") || "product_missing"));
          }
          if (currentState.external_variant_id) {
            await setShopifyVariantInventory({
              variantId: String(currentState.external_variant_id),
              quantity: 0,
              reference: "unverified-supplier-offer:" + candidate.id,
            });
          }
        }
        const { error: saveError } = await db.from("channel_listings").update({
          status: "error",
          last_error: "supplier_offer_not_fulfillable:" + reason,
          last_synced_at: nowIso,
          updated_at: nowIso,
        }).eq("channel", channel).eq("variant_id", candidate.id);
        if (saveError) throw new Error("supplier_offer_disable_state_save_failed:" + saveError.message);
        staleListings.checked++;
        staleListings.unpublished++;
        stateByVariant.set(candidate.id, {
          ...currentState,
          status: "error",
          last_error: "supplier_offer_not_fulfillable:" + reason,
          last_synced_at: nowIso,
        });
        results.push({ variantId: candidate.id, ok: true, externalId: String(currentState.external_product_id), action: "unpublished" });
      } catch (error) {
        staleListings.checked++;
        staleListings.failed++;
        const message = error instanceof Error ? error.message : String(error);
        staleListings.errors.push(candidate.id + ":" + message.slice(0, 160));
        await db.from("channel_listings").update({
          last_error: "supplier_offer_disable_failed:" + reason + ":" + message.slice(0, 120),
          updated_at: nowIso,
        }).eq("channel", channel).eq("variant_id", candidate.id);
        results.push({ variantId: candidate.id, ok: false, error: "supplier_offer_disable_failed:" + reason });
      }
      continue;
    }
    if (!offer || !price || !imageUrl || Number(price.selling_price) <= 0 || Number(price.expected_profit) <= 0) {
      results.push({ variantId: candidate.id, ok: false, error: !offer ? "supplier_offer_missing_or_cost_unknown" : !imageUrl ? "image_url_invalid" : "price_not_profitable" });
      continue;
    }
    // Never manufacture storefront inventory. A listing can remain visible, but it is
    // purchasable only when supplier stock and Japan-bound shipping are evidenced.
    const rawOfferData = offer.raw_data && typeof offer.raw_data === "object" && !Array.isArray(offer.raw_data)
      ? offer.raw_data as Record<string, unknown>
      : {};
    const supplierShippingKnown = rawOfferData.shippingEstimated !== true && (
      rawOfferData.shippingKnown === true ||
      (rawOfferData.shippingKnown === undefined && offer.source_status === "verified" &&
        Number.isFinite(Number(offer.shipping_cost)) && Number(offer.shipping_cost) > 0)
    );
    const supplierStockKnown = rawOfferData.stockKnown === true ||
      (rawOfferData.stockKnown === undefined && offer.source_status === "verified");
     const supplierSaleable = supplierShippingKnown && supplierStockKnown &&
      offer.source_status === "verified" &&
      offer.ship_to === "JP" &&
      offer.tracking_supported === true &&
       Number.isFinite(Number(offer.inventory)) && Number(offer.inventory) > 0;
    // Do not create a visible but non-purchasable listing for an unverified offer.
    if (!supplierSaleable && !currentState?.external_product_id) {
      const missing = missingSaleEvidence({
        supplierCode: offer.supplier_code,
        supplierProductId: offer.supplier_product_id,
        supplierVariantId: offer.supplier_variant_id,
        variantSku: candidate.sku,
        sourceStatus: offer.source_status,
        stockKnown: supplierStockKnown,
        inventory: Number(offer.inventory),
        unitCost: Number(offer.unit_cost),
        shippingKnown: supplierShippingKnown,
        shipTo: offer.ship_to,
        trackingSupported: offer.tracking_supported === true,
         currency: price.currency,
        sellingPrice: Number(price.selling_price),
        expectedProfit: Number(price.expected_profit),
      });
      results.push({
        variantId: candidate.id,
        ok: false,
        error: "supplier_offer_not_fulfillable:" + (missing.length > 0 ? missing.join(",") : "supplier_offer_invalid"),
        missingEvidence: missing,
      });
      continue;
    }
    const storefrontStock = toStorefrontStockQuantity(
      supplierSaleable ? Number(offer.inventory) : 0,
      getStorefrontStockCap(),
    );
    if (!isJapaneseProductTitle(title)) {
      // Do not let a known-invalid generic title pin the oldest candidate at
      // the front of every scheduled batch. Keep the listing unpublished/error
      // and rotate its retry timestamp; never invent a product title.
      const retryAt = new Date().toISOString();
      const { error: invalidTitleStateError } = await db.from("channel_listings").update({
        status: "error",
        last_error: "japanese_product_title_invalid",
        last_synced_at: retryAt,
        updated_at: retryAt,
      }).eq("channel", channel).eq("variant_id", candidate.id);
      if (invalidTitleStateError) {
        results.push({ variantId: candidate.id, ok: false, error: "japanese_product_title_state_save_failed:" + invalidTitleStateError.message });
        continue;
      }
      results.push({ variantId: candidate.id, ok: false, error: "japanese_product_title_invalid" });
      continue;
    }
    const description = (product.description_ja || title + "。商品仕様は販売元の最新情報をご確認ください。").trim();
    // Selling price includes supplier item cost, Japan-bound freight, platform fees and target margin.
    // Remove any legacy copy implying that customers pay supplier freight separately.
    const storefrontDescription = supplierShippingKnown
      ? shippingInclusiveDescription(description)
      : `${description}\n\n日本向け送料を確認中のため、販売を一時停止しています。`;
    // SEO snippet is derived from the real product copy; never invent specifications.
    const seoTitle = `${title.slice(0, 62 - " | TRACER".length).trim()} | TRACER`.slice(0, 70);
    const seoDescription = storefrontDescription.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    const sku = "TRC-" + candidate.id.replace(/-/g, "").slice(0, 24).toUpperCase();
    let baseCreateIdNeedsRecovery: string | null = null;
    try {
      const { data: listing, error: listingError } = await db.from("channel_listings").upsert({
        variant_id: candidate.id, channel, selling_price: Math.round(Number(price.selling_price)),
        external_sku: sku, status: "pending", updated_at: new Date().toISOString()
      }, { onConflict: "channel,variant_id" }).select("id,external_product_id,external_variant_id,last_error").single();
      if (listingError || !listing) throw new Error("listing_claim_failed:" + (listingError?.message ?? "no_row"));
      let externalProductId = listing.external_product_id ? String(listing.external_product_id) : null;
      let externalVariantId = listing.external_variant_id ? String(listing.external_variant_id) : null;
      let publishedUrl: string | null = null;
      if (channel === "base" && !externalProductId) {
        const markerId = String(listing.last_error ?? "").match(/^base_create_id_persist_failed:([^:]+)(?::|$)/)?.[1] ?? null;
        let recoveredId = markerId;
        if (markerId && baseSnapshotItems && !baseItemsById.has(markerId)) throw new Error("base_create_marker_item_not_found:" + markerId);
        if (!recoveredId && stateByVariant.has(candidate.id)) {
          // Existing pending/error rows may represent a timed-out BASE create.
          // Require a complete snapshot before retrying them, to avoid duplicates.
          if (!baseSnapshotItems) throw new Error("base_create_recovery_snapshot_unavailable:" + (baseSnapshotFailure ?? "unknown"));
          const exactMatches = baseSnapshotItems.filter((item) => String(item.identifier ?? "").trim().toUpperCase() === sku);
          if (exactMatches.length > 1) throw new Error("base_identifier_ambiguous:" + sku);
          if (exactMatches.length === 1) recoveredId = String(exactMatches[0].item_id ?? "").trim() || null;
        }
        if (recoveredId) {
          baseCreateIdNeedsRecovery = recoveredId;
          const [skuLinks, idLinks] = await Promise.all([
            db.from("channel_listings").select("id,variant_id,external_product_id").eq("channel", "base").eq("external_sku", sku),
            db.from("channel_listings").select("id,variant_id").eq("channel", "base").eq("external_product_id", recoveredId),
          ]);
          if (skuLinks.error) throw new Error("base_recovery_sku_link_read_failed:" + skuLinks.error.message);
          if (idLinks.error) throw new Error("base_recovery_item_link_read_failed:" + idLinks.error.message);
          if ((skuLinks.data ?? []).some((row) => String(row.id) !== String(listing.id) && String(row.variant_id) !== String(candidate.id))) throw new Error("base_sku_already_mapped_to_other_variant:" + sku);
          if ((idLinks.data ?? []).some((row) => String(row.id) !== String(listing.id) && String(row.variant_id) !== String(candidate.id))) throw new Error("base_item_already_mapped_to_other_variant:" + recoveredId);
          const { data: recovered, error: recoverError } = await db.from("channel_listings")
            .update({ external_product_id: recoveredId, last_error: null, updated_at: new Date().toISOString() })
            .eq("id", listing.id).is("external_product_id", null).select("id").maybeSingle();
          if (recoverError) throw new Error("base_existing_item_id_save_failed:" + recoverError.message);
          if (!recovered) {
            const { data: current, error: currentError } = await db.from("channel_listings").select("external_product_id").eq("id", listing.id).maybeSingle();
            if (currentError || String(current?.external_product_id ?? "") !== recoveredId) throw new Error("base_existing_item_id_recovery_race:" + recoveredId);
          }
          externalProductId = recoveredId;
          baseCreateIdNeedsRecovery = null;
        }
      }
      if (channel === "base") {
        let baseResponse: unknown = null;
        const itemId = externalProductId;
        if (itemId) {
          baseResponse = await editBaseItem({ itemId, title, detail: storefrontDescription, price: Number(price.selling_price), stock: storefrontStock, visible: false });
          externalProductId = itemId;
        } else {
          const response = await createBaseItem({ title, identifier: sku, detail: storefrontDescription, price: Number(price.selling_price), stock: storefrontStock, visible: false });
          baseResponse = response;
          const returned = response.item?.item_id ?? response.item_id;
          externalProductId = String(returned ?? "");
          if (!externalProductId) throw new Error("base_item_id_missing");
          // Preserve the exact returned ID if persistence fails; the next run can recover it.
          baseCreateIdNeedsRecovery = externalProductId;
          const { error: saveCreatedIdError } = await db.from("channel_listings").update({
            external_product_id: externalProductId, external_sku: sku, status: "pending",
            last_error: null, updated_at: new Date().toISOString()
          }).eq("id", listing.id);
          if (saveCreatedIdError) throw new Error("base_created_item_id_save_failed:" + saveCreatedIdError.message);
          baseCreateIdNeedsRecovery = null;
        }
        await addBaseImageWithFormatFallback({ db, variantId: candidate.id, itemId: externalProductId, imageUrl });
        // Only make the item visible after the external ID and image are saved.
        const visibleResponse = await editBaseItem({ itemId: externalProductId, title, detail: storefrontDescription, price: Number(price.selling_price), stock: storefrontStock, visible: true });
        publishedUrl = resolveBasePublicUrl(visibleResponse, externalProductId, basePublicShopUrl)
          ?? resolveBasePublicUrl(baseResponse, externalProductId, basePublicShopUrl);
      } else {
        // Keep the stable variant UUID at the end of the handle. safeSlug truncates
        // at 120 characters, so slugging the combined source key + UUID can cut the UUID
        // off for long source keys and create collisions. Bound the prefix first, then append
        // the complete UUID so every commerce variant receives a deterministic unique handle.
        const handlePrefix = safeSlug(product.source_key).slice(0, 70).replace(/-+$/g, "") || "tracer-item";
        const handle = safeSlug(handlePrefix + "-" + candidate.id.replace(/-/g, ""));
        const productId = toShopifyGid("Product", externalProductId);
        const variantId = toShopifyGid("ProductVariant", externalVariantId);
        type RecoveredShopifyProduct = { id: string; handle: string; vendor?: string | null; tags?: string[]; variants: { nodes: Array<{ id: string; sku?: string | null }> } };
        const isTracerProduct = (item: RecoveredShopifyProduct) => item.vendor === "TRACER" || (item.tags ?? []).includes("TRACER");
        const findTracerProducts = async (query: string) => {
          // Shopify's products connection defaults to active products when status
          // is omitted. Timed-out TRACER creates can remain archived/draft, so search
          // each status explicitly before deciding that a handle is free to create.
          const byId = new Map<string, RecoveredShopifyProduct>();
          for (const status of ["active", "draft", "archived"] as const) {
            const found = await shopifyGraphQL<{ products: { nodes: RecoveredShopifyProduct[] } }>(
              `query CommerceRecoverProduct($query: String!) { products(first: 10, query: $query) { nodes { id handle vendor tags variants(first: 10) { nodes { id sku } } } } }`,
              { query: query + " status:" + status },
            );
            for (const item of found.products?.nodes ?? []) {
              if (isTracerProduct(item)) byId.set(item.id, item);
            }
          }
          return [...byId.values()];
        };
        let recoveredProduct: RecoveredShopifyProduct | null = null;
        if (!productId || !variantId) {
          // Recover an external create whose response was lost before the DB ID was saved.
          // The current handle, the exact SKU, and the legacy 8-character handle are checked
          // separately. A SKU that belongs to more than one TRACER product is not adopted.
          const byHandle = await findTracerProducts("handle:" + handle);
          if (byHandle.length > 1) throw new Error("shopify_handle_ambiguous:" + handle);
          const handleCandidate = byHandle[0] ?? null;
          const handleVariants = handleCandidate?.variants?.nodes ?? [];
          const handleSkuMatches = handleVariants.some((variant) => variant.sku === sku);
          // A timed-out TRACER create can leave the exact handle behind with an empty
          // SKU. Reuse only a single TRACER-owned product with exactly one SKU-empty
          // variant; never adopt a product with a conflicting SKU.
          const handleSkuUnset = handleVariants.length === 1 && !handleVariants[0]?.sku;
          if (handleCandidate && (handleSkuMatches || handleSkuUnset)) recoveredProduct = handleCandidate;
          else if (handleCandidate) throw new Error("shopify_handle_sku_mismatch:" + handle);
          if (!recoveredProduct) {
            const bySku = (await findTracerProducts("sku:" + sku)).filter((item) =>
              (item.variants?.nodes ?? []).some((variant) => variant.sku === sku),
            );
            if (bySku.length > 1) throw new Error("shopify_sku_ambiguous:" + sku);
            recoveredProduct = bySku[0] ?? null;
          }
          if (!recoveredProduct) {
            const legacyHandle = safeSlug(product.source_key + "-" + candidate.id.slice(0, 8));
            if (legacyHandle !== handle) {
              const byLegacyHandle = await findTracerProducts("handle:" + legacyHandle);
              if (byLegacyHandle.length > 1) throw new Error("shopify_legacy_handle_ambiguous:" + legacyHandle);
              const legacy = byLegacyHandle[0] ?? null;
              const legacyVariants = legacy?.variants?.nodes ?? [];
              const skuMatches = legacyVariants.some((variant) => variant.sku === sku);
              const skuUnset = legacyVariants.length === 1 && !legacyVariants[0]?.sku;
              if (legacy && (skuMatches || skuUnset)) recoveredProduct = legacy;
              else if (legacy) throw new Error("shopify_legacy_handle_sku_mismatch:" + legacyHandle);
            }
          }
        }
        const recoveredVariants = recoveredProduct?.variants.nodes ?? [];
        const recoveredVariantId = recoveredVariants.find((variant) => variant.sku === sku)?.id
          ?? (recoveredVariants.length === 1 && !recoveredVariants[0]?.sku ? recoveredVariants[0].id : null);
        const updateWithHandleCollisionRecovery = async (input: {
          productId: string; title: string; descriptionHtml: string; handle: string;
          price: number; variantId: string; sku: string; imageUrl: string | null;
          seoTitle: string; seoDescription: string;
        }) => {
          try {
            return await updateShopifyProduct(input);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A handle can be claimed by an older/orphaned Shopify product even when
            // this listing already has a valid external product ID. Retry only that
            // specific conflict with a stable per-product suffix; never create a
            // second product as a fallback and never mask unrelated API failures.
            if (!/handle.{0,80}already in use|already in use.{0,80}handle/i.test(message)) throw error;
            const productSuffix = String(input.productId).split("/").pop()?.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase()
              || candidate.id.replace(/-/g, "").slice(-10);
            const fallbackHandle = safeSlug(handlePrefix + "-" + candidate.id.replace(/-/g, "") + "-p" + productSuffix);
            if (fallbackHandle === input.handle) throw error;
            return await updateShopifyProduct({ ...input, handle: fallbackHandle });
          }
        };
        const productResult = productId && variantId
          ? await updateWithHandleCollisionRecovery({ productId, title, descriptionHtml: storefrontDescription, handle, price: Number(price.selling_price), variantId, sku, imageUrl, seoTitle, seoDescription })
          : recoveredProduct && recoveredVariantId
            ? await updateWithHandleCollisionRecovery({ productId: recoveredProduct.id, title, descriptionHtml: storefrontDescription, handle, price: Number(price.selling_price), variantId: recoveredVariantId, sku, imageUrl: null, seoTitle, seoDescription })
            : await createShopifyProduct({ title, descriptionHtml: storefrontDescription, handle, price: Number(price.selling_price), sku, imageUrl, seoTitle, seoDescription });
        externalProductId = productResult.id;
        const variant = productResult.variants?.nodes?.[0];
        if (!variant?.id) throw new Error("shopify_variant_id_missing");
        externalVariantId = variant.id;
        await setShopifyVariantInventory({ variantId: variant.id, quantity: storefrontStock, reference: "commerce-core:" + candidate.id });
        const publication = await ensureShopifyProductPublished(productResult.id);
        if (!publication.published) throw new Error("shopify_publication_not_confirmed");
        publishedUrl = "https://" + String(process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "") + "/products/" + productResult.handle;
      }
      // BASE exposes a single sellable item, not a separate variant resource.
      // Mirror its item ID into external_variant_id as the sellable-unit key; order
      // ingestion continues to match the actual BASE order line by external_product_id.
      const mappedExternalVariantId = channel === "base" ? externalProductId : externalVariantId;
      const { error: finishError } = await db.from("channel_listings").update({
        external_product_id: externalProductId, external_variant_id: mappedExternalVariantId, external_sku: sku,
        selling_price: Number(price.selling_price),
        status: "published", published_url: publishedUrl, last_error: null, last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", listing.id);
      if (finishError) throw new Error("listing_result_save_failed:" + finishError.message);
      results.push({ variantId: candidate.id, ok: true, externalId: externalProductId, externalVariantId: mappedExternalVariantId ?? undefined, expectedPrice: Math.round(Number(price.selling_price)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoverableBaseError = channel === "base" && baseCreateIdNeedsRecovery
        ? ("base_create_id_persist_failed:" + baseCreateIdNeedsRecovery + ":" + message).slice(0, 1500)
        : message.slice(0, 1500);
      const { error: recordError } = await db.from("channel_listings").update({ status: "error", last_error: recoverableBaseError, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("variant_id", candidate.id).eq("channel", channel);
      if (recordError) console.error("[commerce-publish] failed to record channel error", { variantId: candidate.id, channel, error: recordError.message });
      results.push({ variantId: candidate.id, ok: false, error: message.slice(0, 300) });
    }
  }

  // Never treat an API write acknowledgement as proof of the customer-facing price.
  // Read back the real storefront price by exact BASE item ID / Shopify variant GID.
  const successfulPriceWrites = results.filter((item) =>
    item.ok && item.action !== "unpublished" && item.expectedPrice !== undefined,
  );
  if (successfulPriceWrites.length > 0) {
    const actualPrices = new Map<string, number | null>();
    let readbackFailure: string | null = null;
    try {
      if (channel === "base") {
        // Read back only the exact item IDs written in this run. A full 5,000-item
        // catalog scan on every publish batch made the cron time out before it could
        // finish verifying even a handful of newly published products.
        for (const item of successfulPriceWrites) {
          const externalItem = await getBaseItemDetail(String(item.externalId ?? ""));
          const rawPrice = externalItem.price;
          const actual = rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === ""
            ? Number.NaN
            : Number(rawPrice);
          actualPrices.set(item.variantId, Number.isFinite(actual) ? Math.round(actual) : null);
        }
      } else {
        const ids = [...new Set(successfulPriceWrites.map((item) => String(item.externalVariantId ?? "")).filter((id) => id.startsWith("gid://shopify/ProductVariant/")))];
        if (ids.length !== successfulPriceWrites.length) throw new Error("shopify_price_readback_variant_id_missing");
        const readback = await shopifyGraphQL<{
          nodes: Array<{ id: string; price: string | null; product: { status: string | null } | null } | null>;
        }>(
          "query TracerStorefrontPriceReadback($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price product { status } } } }",
          { ids },
        );
        const byId = new Map((readback.nodes ?? []).filter((node): node is { id: string; price: string | null; product: { status: string | null } | null } => Boolean(node)).map((node) => [
          node.id,
          { price: node.price === null || node.price === undefined ? Number.NaN : Number(node.price), active: node.product?.status === "ACTIVE" },
        ]));
        for (const item of successfulPriceWrites) {
          const actual = byId.get(String(item.externalVariantId ?? ""));
          actualPrices.set(item.variantId, actual && actual.active && Number.isFinite(actual.price) ? Math.round(actual.price) : null);
        }
      }
    } catch (error) {
      readbackFailure = (error instanceof Error ? error.message : String(error)).replace(/[\\r\\n]+/g, " ").slice(0, 180);
    }
    for (const item of successfulPriceWrites) {
      const actual = actualPrices.get(item.variantId);
      const mismatch = readbackFailure
        ? "storefront_price_readback_failed:" + channel + ":" + readbackFailure
        : actual === null || actual === undefined || actual !== item.expectedPrice
          ? "storefront_price_readback_mismatch:" + channel + ":expected=" + item.expectedPrice + ":actual=" + (actual ?? "unknown")
          : null;
      if (!mismatch) continue;
      const checkedAt = new Date().toISOString();
      const { error: verifySaveError } = await db.from("channel_listings").update({
        status: "error",
        last_error: mismatch,
        last_synced_at: checkedAt,
        updated_at: checkedAt,
      }).eq("channel", channel).eq("variant_id", item.variantId);
      item.ok = false;
      item.error = verifySaveError ? mismatch + ":state_save_failed" : mismatch;
      console.error("[commerce-publish] storefront price readback did not match", {
        channel,
        variantId: item.variantId,
        expectedPrice: item.expectedPrice,
        actualPrice: actual ?? null,
        readbackFailure,
        stateSaveFailed: Boolean(verifySaveError),
      });
    }
  }

  return { channel, staleListings, considered: candidates.length, published: results.filter((x) => x.ok && x.action !== "unpublished").length, processed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
}
