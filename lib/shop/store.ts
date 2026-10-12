import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isShopifyConfigured, shopifyGraphQL } from "@/lib/shopify/admin";
import { womenProductPriority } from "@/lib/intelligence/womens-priority";
import { isPublishableCatalogDescription, isPublishableCatalogTitle } from "@/lib/catalog/publishable-title";
import { getLinkedSupplierListingIds } from "@/lib/catalog/canonical-supplier-identity";
import { hasVerifiedPositiveShopifyStock } from "@/lib/shop/live-stock-policy";

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
    { ids },
  );

  const nodes = data.nodes ?? [];
  for (const node of nodes) {
    if (!node?.id || !ids.includes(node.id)) continue;
    const quantity = asNumber(node.inventoryQuantity);
    if (quantity === null) throw new Error("shopify_live_stock_quantity_unknown");
    liveStock.set(node.id, Math.max(0, Math.floor(quantity)));
  }
  if (ids.some((id) => !liveStock.has(id))) {
    throw new Error("shopify_live_stock_response_incomplete");
  }
  return liveStock;
}

async function loadLiveListings(rows: Record<string, unknown>[]): Promise<ShopListing[]> {
  const mapped = rows.map(mapListing);
  const linkedSupplierIds = await getLinkedSupplierListingIds(mapped.map((listing) => listing.supplierListingId));
  const listings = mapped
    .filter((listing) => Boolean(listing.supplierListingId && linkedSupplierIds.has(listing.supplierListingId)))
    .filter((listing) => isPublishableCatalogTitle(listing.title) && isPublishableCatalogDescription(listing.description) && listing.inventory > 0 && listing.orderable && listing.trackingAvailable && listing.sellingPrice !== null && listing.sellingPrice > 0);

  if (listings.length === 0) return [];

  // A Shopify Admin API failure (e.g. HTTP 401 after a credential change)
  // must not blank the whole storefront: fall back to the DB inventory that
  // inventory-refresh keeps current, exactly as when Shopify is not
  // configured, and log it so the failure is visible in monitoring.
  let liveStock = new Map<string, number>();
  try {
    liveStock = await getLiveShopifyStock(
      listings.map((listing) => listing.shopifyVariantId).filter((id): id is string => Boolean(id)),
    );
  } catch (error) {
    console.error("[shopify-live-stock-unavailable]", error instanceof Error ? error.message.slice(0, 300) : String(error));
    return [];
  }

  const staleSoldOut = listings.filter((listing) => {
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
      const live = listing.shopifyVariantId ? liveStock.get(listing.shopifyVariantId) : undefined;
      return hasVerifiedPositiveShopifyStock(listing.shopifyVariantId, live);
    })
    .map((listing) => {
      const live = listing.shopifyVariantId ? liveStock.get(listing.shopifyVariantId) : undefined;
      return live === undefined ? listing : { ...listing, inventory: live };
    });
}

export async function listPublishedShopListings(): Promise<ShopListing[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select(STOREFRONT_SELECT)
    .eq("published", true)
    .not("shopify_product_id", "is", null)
    .eq("shopify_sync_status", "synced")
    .eq("orderable", true)
    .gt("inventory", 0)
    .eq("tracking_available", true)
    .gt("selling_price", 0)
    .eq("currency", "JPY")
    .order("published_at", { ascending: false })
    .limit(48);

  if (error) throw new Error(error.message);
  const listings = (await loadLiveListings((data ?? []) as Record<string, unknown>[])).filter((listing) => hasJapaneseText(listing.title) && isPublishableCatalogTitle(listing.title) && isPublishableCatalogDescription(listing.description));
  return listings
    .map((listing) => {
      const priority = womenProductPriority({ title: listing.title, category: listing.description });
      return { listing, womenBonus: priority.bonus };
    })
    .sort((a, b) => b.womenBonus - a.womenBonus)
    .map(({ listing }) => listing);
}

export async function getShopListingBySlug(slug: string): Promise<ShopListing | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select(STOREFRONT_SELECT)
    .eq("slug", slug)
    .eq("published", true)
    .not("shopify_product_id", "is", null)
    .eq("shopify_sync_status", "synced")
    .eq("orderable", true)
    .gt("inventory", 0)
    .eq("tracking_available", true)
    .gt("selling_price", 0)
    .eq("currency", "JPY")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  const listings = (await loadLiveListings([data as Record<string, unknown>])).filter((listing) => hasJapaneseText(listing.title) && isPublishableCatalogTitle(listing.title));
  return listings[0] ?? null;
}

export async function recordShopFunnelEvent(args: {
  listingId: string;
  eventType: "impression" | "click" | "view" | "add_to_cart" | "checkout" | "purchase";
  qty?: number;
}): Promise<void> {
  const supabase = createSupabaseAdminClient();
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
    .eq("published", true)
    .not("shopify_product_id", "is", null)
    .eq("shopify_sync_status", "synced")
    .eq("orderable", true)
    .gt("inventory", 0)
    .eq("tracking_available", true)
    .gt("selling_price", 0)
    .eq("currency", "JPY");

  if (error) throw new Error(error.message);
  if (!listings || listings.length !== new Set(listingIds).size) throw new Error("published Shopify listing not found");
  const linkedSupplierIds = await getLinkedSupplierListingIds(listings.map((listing) => listing.supplier_listing_id));
  if (listings.some((listing) => !listing.supplier_listing_id || !linkedSupplierIds.has(String(listing.supplier_listing_id)))) {
    throw new Error("supplier_identity_unlinked");
  }

  const liveStock = await getLiveShopifyStock(
    listings.map((listing) => listing.shopify_variant_id).filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  let subtotal = 0;
  let currency: string | null = null;
  const lines: Array<{ listing: Record<string, unknown>; qty: number; unitPrice: number | null }> = [];

  for (const item of args.items) {
    const listing = listings.find((row) => row.id === item.listingId) as Record<string, unknown> | undefined;
    if (!listing) throw new Error("listing is not published");
    if (!isPublishableCatalogTitle(listing.title)) throw new Error("listing title failed catalog quality gate");
    if (!isPublishableCatalogDescription(listing.description)) throw new Error("listing description failed catalog quality gate");
    if (listing.orderable !== true) throw new Error("listing is not currently orderable");
    const liveQuantity = typeof listing.shopify_variant_id === "string"
      ? liveStock.get(listing.shopify_variant_id)
      : undefined;
    if (!hasVerifiedPositiveShopifyStock(listing.shopify_variant_id, liveQuantity)) {
      throw new Error("shopify_live_stock_unverified");
    }
    const inventory = Math.min(asNumber(listing.inventory) ?? 0, liveQuantity as number);
    if (inventory < item.qty) throw new Error("requested quantity exceeds verified live inventory");
    if (!Number.isFinite(item.qty) || item.qty <= 0) throw new Error("quantity must be greater than zero");
    const unitPrice = asNumber(listing.selling_price);
    if (unitPrice === null || unitPrice <= 0) throw new Error("selling price unknown");
    if (String(listing.currency ?? "").trim().toUpperCase() !== "JPY") throw new Error("currency_not_jpy");
    if (currency && currency !== listing.currency) throw new Error("currency mismatch");
    currency = String(listing.currency);
    subtotal += unitPrice * item.qty;
    lines.push({ listing, qty: item.qty, unitPrice });
  }

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
      metadata: { kind: "observed_checkout" },
    })
    .select("id")
    .single();

  if (orderError) throw new Error(orderError.message);

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

  return { orderId: String(order.id) };
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