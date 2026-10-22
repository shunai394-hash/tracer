import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";
import { womenProductPriority } from "@/lib/intelligence/womens-priority";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { getPublishableSupplierListingStatuses } from "@/lib/catalog/canonical-supplier-identity";
import { hasVerifiedPositiveShopifyStock } from "@/lib/shop/live-stock-policy";
import { isCJLiveOrderPathReady } from "@/lib/config/env";
import { getStorefrontStockCap, toStorefrontStockQuantity } from "@/lib/shopify/storefront-stock";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasJapaneseText(value: unknown): boolean {
  return typeof value === "string" && /[ぁ-んァ-ヶ一-龯々ー]/u.test(value);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

export type ShopListing = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  sellingPrice: number | null;
  currency: string | null;
  inventory: number;
  orderable: boolean;
  trackingAvailable: boolean;
  selectionReasons: string[];
  productId: string;
  bestsellerId: string | null;
  supplierListingId: string | null;
  supplierName: string | null;
  supplierProductId: string | null;
  supplierVariantId: string | null;
  shopifyVariantId: string | null;
  shopifyProductId: string | null;
  shopifyHandle: string | null;
  shopifySyncStatus: string | null;
  canonicalCommerce?: boolean;
  manualInventory?: boolean;
};

function mapListing(row: Record<string, unknown>): ShopListing {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    description: typeof row.description === "string" ? row.description : null,
    imageUrl: typeof row.image_url === "string" ? row.image_url : null,
    sellingPrice: asNumber(row.selling_price),
    currency: typeof row.currency === "string" ? row.currency : null,
    inventory: Math.max(0, Math.floor(asNumber(row.inventory) ?? 0)),
    orderable: asBoolean(row.orderable),
    trackingAvailable: asBoolean(row.tracking_available),
    selectionReasons: Array.isArray(row.selection_reasons)
      ? row.selection_reasons.map(String)
      : [],
    productId: String(row.product_id),
    bestsellerId: row.bestseller_id ? String(row.bestseller_id) : null,
    supplierListingId: row.supplier_listing_id ? String(row.supplier_listing_id) : null,
    supplierName: typeof row.supplier_name === "string" ? row.supplier_name : null,
    supplierProductId: row.supplier_product_id ? String(row.supplier_product_id) : null,
    supplierVariantId: row.supplier_variant_id ? String(row.supplier_variant_id) : null,
    shopifyVariantId: row.shopify_variant_id ? String(row.shopify_variant_id) : null,
    shopifyProductId: row.shopify_product_id ? String(row.shopify_product_id) : null,
    shopifyHandle: typeof row.shopify_handle === "string" ? row.shopify_handle : null,
    shopifySyncStatus: typeof row.shopify_sync_status === "string" ? row.shopify_sync_status : null,
    canonicalCommerce: false,
    manualInventory: row.manual_inventory === true,
  };
}

const STOREFRONT_SELECT = "*";

type ShopifyVariantStock = {
  id: string;
  inventoryQuantity: number | null;
};

async function getLiveShopifyStock(variantIds: string[]): Promise<Map<string, number>> {
  if (!isShopifyConfigured()) throw new Error("shopify_live_stock_unconfigured");
  if (variantIds.length === 0) throw new Error("shopify_live_stock_variant_ids_empty");

  const requestedIds = [...new Set(variantIds)];
  const ids = requestedIds.filter((id) => /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id));
  if (ids.length !== requestedIds.length || ids.length === 0) {
    throw new Error("shopify_live_stock_variant_ids_invalid");
  }
  const liveStock = new Map<string, number>();
  const batchSize = 100;

  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const data = await shopifyGraphQL<{
      nodes: Array<ShopifyVariantStock | null>;
    }>(
      `query LiveVariantInventory($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            inventoryQuantity
          }
        }
      }`,
      { ids: batch },
    );

    for (const node of data.nodes ?? []) {
      if (!node?.id || !batch.includes(node.id)) continue;
      const quantity = asNumber(node.inventoryQuantity);
      if (quantity === null) throw new Error("shopify_live_stock_quantity_unknown");
      liveStock.set(node.id, Math.max(0, Math.floor(quantity)));
    }
    // Missing/retired variants fail closed per listing below. Do not let one
    // stale variant suppress every other healthy product from the storefront.
  }
  return liveStock;
}

async function loadLiveListings(rows: Record<string, unknown>[]): Promise<ShopListing[]> {
  const mapped = rows.map(mapListing);
  const supplierRequired = mapped.filter((listing) => !listing.manualInventory);
  const supplierStatuses = await getPublishableSupplierListingStatuses(supplierRequired.map((listing) => ({
    listingId: listing.id,
    supplierListingId: listing.supplierListingId,
    productId: listing.productId,
    supplierProductId: listing.supplierProductId,
    supplierVariantId: listing.supplierVariantId,
  })));
  const listings = mapped
    // TRACER-managed listings use the stock entered in this dashboard. Other
    // listings still require a synced Shopify variant and verified supplier identity.
    .filter((listing) => listing.manualInventory || (listing.shopifySyncStatus === "synced" && Boolean(listing.shopifyVariantId)))
    .filter((listing) => listing.manualInventory || supplierStatuses.has(listing.id))
    .filter((listing) => isPublishableCatalogTitle(listing.title) && isPublishableCatalogDescription(listing.description) && listing.inventory > 0 && (listing.manualInventory || (listing.orderable && listing.trackingAvailable)) && listing.sellingPrice !== null && listing.sellingPrice > 0 && Boolean(listing.imageUrl));

  if (listings.length === 0) return [];

  const shopifyListings = listings.filter((listing) => !listing.manualInventory);
  if (shopifyListings.length === 0) return listings;
  let liveStock = new Map<string, number>();
  try {
    liveStock = await getLiveShopifyStock(
      shopifyListings.map((listing) => listing.shopifyVariantId).filter((id): id is string => Boolean(id)),
    );
  } catch (error) {
    console.error("[shopify-live-stock-unavailable]", error instanceof Error ? error.message.slice(0, 300) : String(error));
    // Supplier-backed listings must not fall back to stale cached inventory when
    // Shopify's live quantity cannot be read. Keep only explicitly manual-stock
    // listings; they are managed in TRACER and do not depend on Shopify readback.
    return listings.filter((listing) => listing.manualInventory);
  }

  const staleSoldOut = shopifyListings.filter((listing) => {
    const live = listing.shopifyVariantId ? liveStock.get(listing.shopifyVariantId) : undefined;
    return live !== undefined && live <= 0;
  });

  if (staleSoldOut.length > 0) {
    const supabase = createSupabaseAdminClient();
    const now = new Date().toISOString();
    for (const listing of staleSoldOut) {
      await supabase
        .from("shop_listings")
        .update({
          inventory: 0,
          orderable: false,
          pipeline_updated_at: now,
          updated_at: now,
        })
        .eq("id", listing.id);
    }
  }

  return listings
    .filter((listing) => {
      if (listing.manualInventory) return true;
      const live = listing.shopifyVariantId ? liveStock.get(listing.shopifyVariantId) : undefined;
      return hasVerifiedPositiveShopifyStock(listing.shopifyVariantId, live);
    })
    .map((listing) => {
      if (listing.manualInventory) return listing;
      const live = listing.shopifyVariantId ? liveStock.get(listing.shopifyVariantId) : undefined;
      return live === undefined ? listing : { ...listing, inventory: live };
    });
}

export async function listPublishedShopListings(): Promise<ShopListing[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select(STOREFRONT_SELECT)
    .is("archived_at", null)
    .eq("published", true)
    .or("manual_inventory.eq.true,and(shopify_product_id.not.is.null,shopify_sync_status.eq.synced,orderable.eq.true,tracking_available.eq.true)")
    .gt("inventory", 0)
    .gt("selling_price", 0)
    .eq("currency", "JPY")
    .order("published_at", { ascending: false })
    .limit(1800);

  if (error) throw new Error(error.message);
  const legacyListings = (await loadLiveListings((data ?? []) as Record<string, unknown>[])).filter((listing) => hasJapaneseText(listing.title) && isPublishableCatalogTitle(listing.title) && isPublishableCatalogDescription(listing.description));
  const canonicalListings = await loadCanonicalCommerceListings();
  const byVariant = new Map<string, ShopListing>();
  for (const listing of legacyListings) {
    if (listing.manualInventory) byVariant.set(`manual:${listing.id}`, listing);
    else if (listing.shopifyVariantId) byVariant.set(listing.shopifyVariantId, listing);
  }
  for (const listing of canonicalListings) if (listing.shopifyVariantId) byVariant.set(listing.shopifyVariantId, listing);
  const listings = [...byVariant.values()];
  // De-duplicate identical customer-facing cards across supplier records.
  // Do not use title alone: generic titles can represent different products.
  // Keep one original listing identity for checkout and procurement.
  const storefrontProducts = new Map<string, ShopListing>();
  for (const listing of listings) {
    const titleKey = listing.title.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const imageKey = listing.imageUrl?.trim() ?? "";
    const duplicateKey = !listing.manualInventory && titleKey && imageKey
      ? ["visible-product", titleKey, imageKey, String(listing.sellingPrice ?? ""), listing.currency?.trim().toUpperCase() ?? ""].join(":")
      : `listing:${listing.id}`;
    if (!storefrontProducts.has(duplicateKey)) storefrontProducts.set(duplicateKey, listing);
  }
  return [...storefrontProducts.values()]
    .map((listing) => {
      const priority = womenProductPriority({ title: listing.title, category: listing.description });
      return { listing, womenBonus: priority.bonus };
    })
    .sort((a, b) => b.womenBonus - a.womenBonus)
    .map(({ listing }) => listing);
}

export async function getShopListingBySlug(slug: string): Promise<ShopListing | null> {
  const supabase = createSupabaseAdminClient();
  const baseQuery = supabase.from("shop_listings").select(STOREFRONT_SELECT);
  // Stable UUID paths avoid URL-encoding ambiguity for Japanese product slugs
  // when external channels validate a public sales link.
  const isListingId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
  const listingQuery = isListingId ? baseQuery.eq("id", slug) : baseQuery.eq("slug", slug);
  const { data, error } = await listingQuery
    .is("archived_at", null)
    .eq("published", true)
    .or("manual_inventory.eq.true,and(shopify_product_id.not.is.null,shopify_sync_status.eq.synced,orderable.eq.true,tracking_available.eq.true)")
    .gt("inventory", 0)
    .gt("selling_price", 0)
    .eq("currency", "JPY")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    if (!isListingId) return null;
    const canonical = await loadCanonicalCommerceListings({ variantIds: [slug] });
    return canonical.find((listing) => listing.id === slug) ?? null;
  }

  const listing = mapListing(data as Record<string, unknown>);
  if (!isPublishableCatalogTitle(listing.title) || !isPublishableCatalogDescription(listing.description) || !hasJapaneseText(listing.title) || !listing.imageUrl) return null;
  if (!listing.manualInventory) {
    if (!listing.supplierListingId || !listing.shopifyProductId || !listing.shopifyVariantId || !listing.shopifyHandle) return null;
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(listing.shopifyVariantId)) return null;
  }

  // The public product page is a landing page that sends customers to the
  // already-published Shopify product. Supplier identity and live-stock checks
  // remain mandatory in publication and order-time procurement paths, but must
  // not turn an existing public sales URL into a 404.
  return listing;
}

export 
async function loadCanonicalCommerceListings(options: { variantIds?: string[] } = {}): Promise<ShopListing[]> {
  // Catalog visibility is separate from TRACER's local CJ auto-procurement capability.
  // Canonical rows link to an already-published Shopify product; keep orderable=false
  // until live supplier ordering/payment readiness is verified.
  // UUID product-page liveness checks must query one variant, not rebuild the full catalog.
  const supabase = createSupabaseAdminClient();
  const freshAfter = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  let channelQuery = supabase
    .from("channel_listings")
    .select("id,variant_id,external_product_id,external_variant_id,external_sku,published_url,status,channel,updated_at")
    .eq("channel", "shopify")
    .eq("status", "published")
    .not("external_product_id", "is", null)
    .not("external_variant_id", "is", null)
    .not("published_url", "is", null);
  if (options.variantIds?.length) channelQuery = channelQuery.in("variant_id", options.variantIds);
  const { data: channelRows, error: channelError } = await channelQuery
    .order("updated_at", { ascending: false })
    .limit(options.variantIds?.length ? options.variantIds.length : 1800);
  if (channelError) throw new Error(channelError.message);
  const rows = (channelRows ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return [];
  const variantIds = [...new Set(rows.map((row) => String(row.variant_id ?? "")).filter(Boolean))];
  const variants: Record<string, unknown>[] = [];
  const validOffers: Record<string, unknown>[] = [];
  const validPrices: Record<string, unknown>[] = [];
  // Keep PostgREST URLs bounded: large .in() filters can exceed proxy/request limits
  // and return HTTP 400 before any rows are read. Fetch the three related datasets
  // in small, deterministic batches and combine them before matching.
  const queryBatchSize = 40;
  for (let offset = 0; offset < variantIds.length; offset += queryBatchSize) {
    const batch = variantIds.slice(offset, offset + queryBatchSize);
    const [
      { data: batchVariants, error: variantError },
      { data: batchOffers, error: offerError },
      { data: batchPrices, error: priceError },
    ] = await Promise.all([
      supabase.from("commerce_variants")
        .select("id,product_id,source_variant_key,title_ja,sku,commerce_products!inner(id,source_key,title_ja,description_ja,image_url,category,active)")
        .in("id", batch)
        .eq("commerce_products.active", true),
      supabase.from("supplier_offers")
        .select("id,variant_id,supplier_code,supplier_product_id,supplier_variant_id,inventory,ship_to,tracking_supported,source_status,last_checked_at")
        .in("variant_id", batch)
        .eq("source_status", "verified")
        .eq("tracking_supported", true)
        .eq("ship_to", "JP")
        .gt("inventory", 0)
        .gte("last_checked_at", freshAfter),
      supabase.from("commerce_prices")
        .select("variant_id,supplier_offer_id,currency,selling_price,expected_profit,margin_rate")
        .in("variant_id", batch)
        .eq("currency", "JPY")
        .gt("selling_price", 0)
        .gt("expected_profit", 0),
    ]);
    if (variantError) throw new Error(variantError.message);
    if (offerError) throw new Error(offerError.message);
    if (priceError) throw new Error(priceError.message);
    variants.push(...((batchVariants ?? []) as Record<string, unknown>[]));
    validOffers.push(...((batchOffers ?? []) as Record<string, unknown>[]));
    validPrices.push(...((batchPrices ?? []) as Record<string, unknown>[]));
  }
  const variantsById = new Map<string, Record<string, unknown>>();
  for (const variant of (variants ?? []) as Record<string, unknown>[]) variantsById.set(String(variant.id), variant);
  const candidates: ShopListing[] = [];

  for (const channel of rows) {
    const variantId = String(channel.variant_id ?? "");
    const variant = variantsById.get(variantId);
    if (!variant) continue;
    const rawProduct = variant.commerce_products;
    const product = (Array.isArray(rawProduct) ? rawProduct[0] : rawProduct) as Record<string, unknown> | null;
    if (!product || product.active !== true) continue;
    // Match price and offer as a pair. An unrelated/stale price row must not
    // hide a variant that has another profitable price linked to a verified offer.
    const linkedPairs = validPrices
      .filter((item) => String(item.variant_id) === variantId && Number(item.selling_price) > 0 && Number(item.expected_profit) > 0)
      .map((item) => ({ price: item, offer: validOffers.find((candidate) =>
        String(candidate.id) === String(item.supplier_offer_id) && String(candidate.variant_id) === variantId &&
        Boolean(candidate.supplier_product_id) && Boolean(candidate.supplier_variant_id) &&
        Number(candidate.inventory) > 0 && candidate.source_status === "verified" &&
        candidate.tracking_supported === true && candidate.ship_to === "JP"
      ) }))
      .filter((pair): pair is { price: Record<string, unknown>; offer: Record<string, unknown> } => Boolean(pair.offer))
      .sort((a, b) => Number(b.price.expected_profit) - Number(a.price.expected_profit));
    const selectedPair = linkedPairs[0];
    if (!selectedPair) continue;
    const { price, offer } = selectedPair;
    const checkedAt = typeof offer.last_checked_at === "string" ? Date.parse(offer.last_checked_at) : Number.NaN;
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > 24 * 60 * 60_000 || checkedAt > Date.now() + 5 * 60_000) continue;
    const title = String(variant.title_ja || product.title_ja || "").trim();
    const description = typeof product.description_ja === "string" ? product.description_ja : null;
    const imageUrl = typeof product.image_url === "string" ? product.image_url : null;
    if (!title || !description || !imageUrl || !hasJapaneseText(title) || !isPublishableCatalogTitle(title) || !isPublishableCatalogDescription(description)) continue;
    try {
      const image = new URL(imageUrl);
      if (image.protocol !== "https:" && image.protocol !== "http:") continue;
    } catch {
      continue;
    }
    const publishedUrl = String(channel.published_url ?? "");
    let handle: string | null = null;
    try {
      const parsed = new URL(publishedUrl);
      const match = parsed.pathname.match(/\/products\/([^/]+)/);
      handle = match?.[1] ? decodeURIComponent(match[1]) : null;
    } catch {
      handle = null;
    }
    const shopifyVariantId = String(channel.external_variant_id ?? "");
    const shopifyProductId = String(channel.external_product_id ?? "");
    if (!handle || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(shopifyVariantId) || !/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyProductId)) continue;
    candidates.push({
      id: variantId,
      slug: variantId,
      title,
      description,
      imageUrl,
      sellingPrice: asNumber(price.selling_price),
      currency: "JPY",
      inventory: toStorefrontStockQuantity(Number(offer.inventory), getStorefrontStockCap()),
      orderable: isCJLiveOrderPathReady(),
      trackingAvailable: true,
      selectionReasons: ["仕入先在庫確認済み", "日本向け配送確認済み", "利益計算済み"],
      productId: String(product.id),
      bestsellerId: null,
      supplierListingId: String(offer.id),
      supplierName: String(offer.supplier_code ?? "CJ"),
      supplierProductId: String(offer.supplier_product_id),
      supplierVariantId: String(offer.supplier_variant_id),
      shopifyVariantId,
      shopifyProductId,
      shopifyHandle: handle,
      shopifySyncStatus: "synced",
      canonicalCommerce: true,
    });
  }
  if (candidates.length === 0) return [];

  try {
    const liveStock = await getLiveShopifyStock(candidates.map((listing) => listing.shopifyVariantId).filter((id): id is string => Boolean(id)));
    return candidates.flatMap((listing) => {
      const live = listing.shopifyVariantId ? liveStock.get(listing.shopifyVariantId) : undefined;
      if (!hasVerifiedPositiveShopifyStock(listing.shopifyVariantId, live)) return [];
      const supplierStock = listing.inventory;
      return [{ ...listing, inventory: toStorefrontStockQuantity(Math.min(supplierStock, live ?? 0), getStorefrontStockCap()) }];
    });
  } catch (error) {
    console.error("[canonical-commerce-live-stock-unavailable]", error instanceof Error ? error.message.slice(0, 300) : String(error));
    return candidates;
  }
}

export async function recordShopFunnelEvent(args: {
  listingId: string;
  eventType: "impression" | "click" | "view" | "add_to_cart" | "checkout" | "purchase";
  qty?: number;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { data: legacyListing, error: lookupError } = await supabase.from("shop_listings").select("id").eq("id", args.listingId).maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  if (!legacyListing) {
    const { error } = await supabase.from("commerce_events").insert({
      event_key: "shop-funnel:" + args.listingId + ":" + args.eventType + ":" + Date.now() + ":" + Math.random().toString(36).slice(2, 10),
      event_type: "shop_" + args.eventType,
      entity_type: "commerce_variant",
      entity_id: args.listingId,
      status: "ok",
      detail: { qty: args.qty ?? 1 },
    });
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.from("shop_funnel_events").insert({
    listing_id: args.listingId,
    event_type: args.eventType,
    qty: args.qty ?? 1,
  });
  if (error) throw new Error(error.message);
}

export async function placeShopOrder(args: {
  items: Array<{ listingId: string; qty: number }>;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingAddress: string;
  shippingCountryCode?: string | null;
  shippingProvince?: string | null;
  shippingCity?: string | null;
  shippingZip?: string | null;
  shippingLine1?: string | null;
  paymentMethod: "cash_on_delivery" | "bank_transfer" | "card";
  notes?: string;
}): Promise<{ orderId: string }> {
  const supabase = createSupabaseAdminClient();
  if (args.items.length === 0) throw new Error("cart is empty");

  const listingIds = args.items.map((item) => item.listingId);
  const { data: listings, error } = await supabase
    .from("shop_listings")
    .select("*")
    .in("id", listingIds)
    .is("archived_at", null)
    .eq("published", true)
    .or("manual_inventory.eq.true,and(shopify_product_id.not.is.null,shopify_sync_status.eq.synced,orderable.eq.true,tracking_available.eq.true)")
    .gt("inventory", 0)
    .gt("selling_price", 0)
    .eq("currency", "JPY");

  if (error) throw new Error(error.message);
  if (!listings || listings.length !== new Set(listingIds).size) throw new Error("published listing not found");

  const supplierRequired = listings.filter((listing) => listing.manual_inventory !== true);
  const supplierStatuses = await getPublishableSupplierListingStatuses(supplierRequired.map((listing) => ({
    listingId: String(listing.id),
    supplierListingId: listing.supplier_listing_id == null ? null : String(listing.supplier_listing_id),
    productId: listing.product_id == null ? null : String(listing.product_id),
    supplierProductId: listing.supplier_product_id == null ? null : String(listing.supplier_product_id),
    supplierVariantId: listing.supplier_variant_id == null ? null : String(listing.supplier_variant_id),
  })));
  if (supplierRequired.some((listing) => !listing.supplier_listing_id || !supplierStatuses.has(String(listing.id)))) {
    throw new Error("supplier_identity_unlinked");
  }

  const shopifyListings = listings.filter((listing) => listing.manual_inventory !== true);
  const liveStock = shopifyListings.length
    ? await getLiveShopifyStock(shopifyListings.map((listing) => listing.shopify_variant_id).filter((id): id is string => typeof id === "string" && id.length > 0))
    : new Map<string, number>();

  let subtotal = 0;
  let currency: string | null = null;
  const lines: Array<{ listing: Record<string, unknown>; qty: number; unitPrice: number | null }> = [];

  for (const item of args.items) {
    const listing = listings.find((row) => row.id === item.listingId) as Record<string, unknown> | undefined;
    if (!listing) throw new Error("listing is not published");
    if (!Number.isInteger(item.qty) || item.qty <= 0) throw new Error("quantity must be a positive integer");
    if (!isPublishableCatalogTitle(listing.title)) throw new Error("listing title failed catalog quality gate");
    if (!isPublishableCatalogDescription(listing.description)) throw new Error("listing description failed catalog quality gate");
    const manual = listing.manual_inventory === true;
    if (!manual && listing.orderable !== true) throw new Error("listing is not currently orderable");
    const liveQuantity = typeof listing.shopify_variant_id === "string" ? liveStock.get(listing.shopify_variant_id) : undefined;
    if (!manual && !hasVerifiedPositiveShopifyStock(listing.shopify_variant_id as string | null, liveQuantity)) {
      throw new Error("shopify_live_stock_unverified");
    }
    const inventory = manual ? (asNumber(listing.inventory) ?? 0) : Math.min(asNumber(listing.inventory) ?? 0, liveQuantity as number);
    if (inventory < item.qty) throw new Error("requested quantity exceeds available inventory");
    if (String(listing.currency ?? "").trim().toUpperCase() !== "JPY") throw new Error("currency must be JPY");
    const unitPrice = asNumber(listing.selling_price);
    if (unitPrice === null || unitPrice <= 0) throw new Error("selling price unknown");
    if (currency && listing.currency && currency !== listing.currency) throw new Error("currency mismatch");
    currency = typeof listing.currency === "string" ? listing.currency : currency;
    subtotal += unitPrice * item.qty;
    lines.push({ listing, qty: item.qty, unitPrice });
  }

  const reserved: Array<{ listingId: string; qty: number }> = [];
  for (const line of lines) {
    if (line.listing.manual_inventory !== true) continue;
    const { data, error: reserveError } = await supabase.rpc("reserve_manual_listing_stock", {
      p_listing_id: String(line.listing.id),
      p_quantity: line.qty,
    });
    if (reserveError || data !== true) {
      for (const item of reserved) {
        await supabase.rpc("release_manual_listing_stock", { p_listing_id: item.listingId, p_quantity: item.qty });
      }
      throw new Error("manual_inventory_changed_refresh_cart");
    }
    reserved.push({ listingId: String(line.listing.id), qty: line.qty });
  }

  let orderId: string | null = null;
  try {
    const { data: order, error: orderError } = await supabase
      .from("shop_orders")
      .insert({
        listing_id: lines[0].listing.id,
        status: "placed",
        payment_method: args.paymentMethod,
        payment_status: "pending",
        order_status: "pending_payment",
        paid_at: null,
        customer_name: args.customerName,
        customer_email: args.customerEmail,
        customer_phone: args.customerPhone,
        shipping_address: args.shippingAddress,
        shipping_country_code: args.shippingCountryCode ?? null,
        shipping_province: args.shippingProvince ?? null,
        shipping_city: args.shippingCity ?? null,
        shipping_zip: args.shippingZip ?? null,
        shipping_line1: args.shippingLine1 ?? null,
        subtotal,
        shipping_cost: null,
        total: subtotal,
        currency,
        notes: args.notes ?? null,
        metadata: { kind: "observed_checkout", inventorySource: lines.some((line) => line.listing.manual_inventory === true) ? "mixed_or_manual" : "supplier" },
      })
      .select("id")
      .single();

    if (orderError || !order) throw new Error(orderError?.message ?? "order_create_failed");
    orderId = String(order.id);

    for (const line of lines) {
      const itemInsert = await supabase.from("shop_order_items").insert({
        order_id: order.id,
        listing_id: line.listing.id,
        product_id: line.listing.product_id,
        supplier_listing_id: line.listing.supplier_listing_id ?? null,
        supplier_name: line.listing.supplier_name ?? null,
        supplier_product_id: line.listing.supplier_product_id ?? null,
        supplier_variant_id: line.listing.supplier_variant_id ?? null,
        title: String(line.listing.title),
        qty: line.qty,
        unit_price: line.unitPrice,
        currency,
      });
      if (itemInsert.error) throw new Error(itemInsert.error.message);
    }
    return { orderId };
  } catch (error) {
    if (orderId) await supabase.from("shop_orders").delete().eq("id", orderId);
    for (const item of reserved) {
      await supabase.rpc("release_manual_listing_stock", { p_listing_id: item.listingId, p_quantity: item.qty });
    }
    throw error;
  }
}

export async function attachStripeCheckoutSession(args: {
  orderId: string;
  stripeCheckoutSessionId: string;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("shop_orders")
    .update({ stripe_checkout_session_id: args.stripeCheckoutSessionId })
    .eq("id", args.orderId);
  if (error) throw new Error(error.message);
}
