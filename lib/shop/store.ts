import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type ShopListing = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  sellingPrice: number | null;
  currency: string | null;
  selectionReasons: string[];
  productId: string;
  bestsellerId: string | null;
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
    selectionReasons: Array.isArray(row.selection_reasons)
      ? row.selection_reasons.map(String)
      : [],
    productId: String(row.product_id),
    bestsellerId: row.bestseller_id ? String(row.bestseller_id) : null,
  };
}

export async function listPublishedShopListings(): Promise<ShopListing[]> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select("*")
    .eq("published", true)
    .order("published_at", { ascending: false })
    .limit(3);

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => mapListing(row as Record<string, unknown>));
}

export async function getShopListingBySlug(
  slug: string,
): Promise<ShopListing | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("shop_listings")
    .select("*")
    .eq("slug", slug)
    .eq("published", true)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? mapListing(data as Record<string, unknown>) : null;
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
  paymentMethod: "cash_on_delivery" | "bank_transfer";
  notes?: string;
}): Promise<{ orderId: string }> {
  const supabase = createSupabaseAdminClient();
  if (args.items.length === 0) {
    throw new Error("cart is empty");
  }

  const listingIds = args.items.map((item) => item.listingId);
  const { data: listings, error } = await supabase
    .from("shop_listings")
    .select("*")
    .in("id", listingIds)
    .eq("published", true);

  if (error) throw new Error(error.message);
  if (!listings || listings.length === 0) {
    throw new Error("published listing not found");
  }

  let subtotal = 0;
  let currency: string | null = null;
  const lines: Array<{
    listing: Record<string, unknown>;
    qty: number;
    unitPrice: number | null;
  }> = [];

  for (const item of args.items) {
    const listing = listings.find((row) => row.id === item.listingId) as
      | Record<string, unknown>
      | undefined;
    if (!listing) throw new Error("listing is not published");
    const unitPrice = asNumber(listing.selling_price);
    if (unitPrice === null) throw new Error("selling price unknown");
    if (currency && listing.currency && currency !== listing.currency) {
      throw new Error("currency mismatch");
    }
    currency = typeof listing.currency === "string" ? listing.currency : currency;
    subtotal += unitPrice * item.qty;
    lines.push({ listing, qty: item.qty, unitPrice });
  }

  const { data: order, error: orderError } = await supabase
    .from("shop_orders")
    .insert({
      listing_id: lines[0].listing.id,
      status: "placed",
      payment_method: args.paymentMethod,
      customer_name: args.customerName,
      customer_email: args.customerEmail,
      customer_phone: args.customerPhone,
      shipping_address: args.shippingAddress,
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
      title: String(line.listing.title),
      qty: line.qty,
      unit_price: line.unitPrice,
      currency,
    });
    if (itemInsert.error) throw new Error(itemInsert.error.message);

    await recordShopFunnelEvent({
      listingId: String(line.listing.id),
      eventType: "purchase",
      qty: line.qty,
    });
  }

  return { orderId: String(order.id) };
}
