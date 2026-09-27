import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getBaseOrderDetail, listBaseOrders, isBaseConfigured } from "@/lib/channels/base";
import { createDropshipPurchaseOrdersForShopOrder } from "@/lib/ordering/dropship";

export type BaseOrderSyncResult = {
  configured: boolean;
  checked: number;
  imported: number;
  procurementCreated: number;
  skipped: number;
  failed: number;
  results: Array<{
    baseOrderKey: string;
    ok: boolean;
    imported: boolean;
    shopOrderId?: string;
    purchaseOrderIds?: string[];
    skipped?: boolean;
    error?: string;
  }>;
};

function paymentMethod(payment: string | undefined): "cash_on_delivery" | "bank_transfer" | "card" {
  if (payment === "base_bt") return "bank_transfer";
  if (payment === "cod") return "cash_on_delivery";
  return "card";
}

export async function syncBaseOrdersToTracer(limit = 50): Promise<BaseOrderSyncResult> {
  if (!isBaseConfigured()) {
    return {
      configured: false,
      checked: 0,
      imported: 0,
      procurementCreated: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
  }

  const supabase = createSupabaseAdminClient();
  const summaries = await listBaseOrders({ limit: Math.min(100, Math.max(1, limit)) });
  const results: BaseOrderSyncResult["results"] = [];

  for (const summary of summaries) {
    const baseOrderKey = String(summary.unique_key);
    try {
      const { data: existing } = await supabase
        .from("shop_orders")
        .select("id")
        .eq("base_order_key", baseOrderKey)
        .maybeSingle();

      if (existing?.id) {
        results.push({
          baseOrderKey,
          ok: true,
          imported: false,
          shopOrderId: String(existing.id),
          skipped: true,
        });
        continue;
      }

      if (summary.dispatch_status === "cancelled" || summary.dispatch_status === "unshippable") {
        results.push({
          baseOrderKey,
          ok: true,
          imported: false,
          skipped: true,
        });
        continue;
      }

      const order = await getBaseOrderDetail(baseOrderKey);
      const baseItems = (order.order_items ?? []).filter(
        (item) => item.status !== "cancelled" && item.item_id !== undefined,
      );
      if (baseItems.length === 0) {
        results.push({ baseOrderKey, ok: false, imported: false, error: "no_active_order_items" });
        continue;
      }

      const itemIds = baseItems.map((item) => String(item.item_id));
      const { data: listings, error: listingError } = await supabase
        .from("shop_listings")
        .select("id,product_id,title,selling_price,currency,base_item_id,published,supplier_listing_id,supplier_name,supplier_product_id,supplier_variant_id")
        .in("base_item_id", itemIds);

      if (listingError) throw new Error(listingError.message);

      const listingByBaseItem = new Map(
        (listings ?? []).map((listing) => [String(listing.base_item_id), listing]),
      );
      const unresolved = itemIds.filter((id) => !listingByBaseItem.has(id));
      if (unresolved.length > 0) {
        results.push({
          baseOrderKey,
          ok: false,
          imported: false,
          error: `base_items_not_mapped:${unresolved.join(",")}`,
        });
        continue;
      }

      const firstListing = listingByBaseItem.get(itemIds[0]);
      if (!firstListing) throw new Error("base listing mapping missing");

      const firstName = String(order.first_name ?? "");
      const lastName = String(order.last_name ?? "");
      const shippingAddress = [
        order.prefecture,
        order.address,
        order.address2,
      ].filter(Boolean).join(" ");

      const { data: shopOrder, error: orderError } = await supabase
        .from("shop_orders")
        .insert({
          listing_id: firstListing.id,
          status: "placed",
          payment_method: paymentMethod(order.payment),
          customer_name: [firstName, lastName].filter(Boolean).join(" ") || "BASE customer",
          customer_email: String(order.mail_address ?? ""),
          customer_phone: String(order.tel ?? ""),
          shipping_address: shippingAddress,
          subtotal: Number(order.total ?? 0),
          shipping_cost: Number(order.shipping_fee ?? 0),
          total: Number(order.total ?? 0),
          currency: firstListing.currency ?? "JPY",
          notes: order.remark ?? null,
          payment_status: summary.dispatch_status === "unpaid" ? "pending" : "paid",
          order_status: summary.dispatch_status === "unpaid" ? "pending_payment" : "fulfillment_pending",
          base_order_key: baseOrderKey,
          base_order_synced_at: new Date().toISOString(),
          metadata: {
            source: "base",
            base_order_key: baseOrderKey,
            base_dispatch_status: order.dispatch_status ?? null,
            base_payment: order.payment ?? null,
          },
        })
        .select("id")
        .single();

      if (orderError) throw new Error(orderError.message);

      for (const baseItem of baseItems) {
        const listing = listingByBaseItem.get(String(baseItem.item_id));
        if (!listing) throw new Error(`listing_not_found_for_base_item:${baseItem.item_id}`);

        const { error: itemError } = await supabase.from("shop_order_items").insert({
          order_id: shopOrder.id,
          listing_id: listing.id,
          product_id: listing.product_id,
          supplier_listing_id: listing.supplier_listing_id ?? null,
          supplier_name: listing.supplier_name ?? null,
          supplier_product_id: listing.supplier_product_id ?? null,
          supplier_variant_id: listing.supplier_variant_id ?? null,
          title: listing.title,
          qty: Number(baseItem.amount ?? 1),
          unit_price: Number(baseItem.price ?? listing.selling_price ?? 0),
          currency: listing.currency ?? "JPY",
        });
        if (itemError) throw new Error(itemError.message);
      }

      let procurement = { purchaseOrderIds: [] as string[], skipped: [] as Array<{ itemId: string; reason: string }> };
      if (summary.dispatch_status !== "unpaid") {
        procurement = await createDropshipPurchaseOrdersForShopOrder(String(shopOrder.id));
      }

      results.push({
        baseOrderKey,
        ok: true,
        imported: true,
        shopOrderId: String(shopOrder.id),
        purchaseOrderIds: procurement.purchaseOrderIds,
      });
    } catch (error) {
      results.push({
        baseOrderKey,
        ok: false,
        imported: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    configured: true,
    checked: results.length,
    imported: results.filter((item) => item.imported).length,
    procurementCreated: results.reduce(
      (sum, item) => sum + (item.purchaseOrderIds?.length ?? 0),
      0,
    ),
    skipped: results.filter((item) => item.skipped).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
}
