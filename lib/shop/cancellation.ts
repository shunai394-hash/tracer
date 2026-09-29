import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getStripeClient } from "@/lib/payments/stripe/client";

const BLOCKED_STATUSES = new Set([
  "cancellation_requested",
  "refund_pending",
  "cancelled",
  "refunded",
]);

export type ShopCancellationResult = {
  orderId: string;
  status: string;
  refundRequested: boolean;
  supplierOrderPlaced: boolean;
  reason: string | null;
};

export async function requestShopOrderCancellation(args: {
  orderId: string;
  customerEmail: string;
  reason?: string | null;
}): Promise<ShopCancellationResult> {
  const supabase = createSupabaseAdminClient();
  const email = args.customerEmail.trim().toLowerCase();

  const { data: order, error } = await supabase
    .from("shop_orders")
    .select("*")
    .eq("id", args.orderId)
    .ilike("customer_email", email)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) throw new Error("注文が見つかりません。");
  if (BLOCKED_STATUSES.has(String(order.order_status))) {
    return {
      orderId: args.orderId,
      status: String(order.order_status),
      refundRequested: false,
      supplierOrderPlaced: false,
      reason: "already_cancelled_or_refund_in_progress",
    };
  }
  if (String(order.order_status) === "delivered") {
    return {
      orderId: args.orderId,
      status: "delivered",
      refundRequested: false,
      supplierOrderPlaced: false,
      reason: "delivered_order_requires_manual_review",
    };
  }

  const { data: purchaseOrders } = await supabase
    .from("purchase_orders")
    .select("id,supplier_order_id,status")
    .eq("shop_order_id", args.orderId)
    .eq("fulfillment_kind", "dropship_customer_order");

  const supplierOrderPlaced = Boolean(
    (purchaseOrders ?? []).some((po) => po.supplier_order_id),
  );

  const now = new Date().toISOString();

  // This state is the kill switch for all subsequent supplier execution.
  await supabase
    .from("shop_orders")
    .update({
      order_status: supplierOrderPlaced ? "refund_pending" : "cancellation_requested",
      cancellation_requested_at: now,
      cancellation_reason: args.reason?.trim() || "customer_requested",
      cancellation_source: "customer",
    })
    .eq("id", args.orderId);

  if (supplierOrderPlaced) {
    return {
      orderId: args.orderId,
      status: "refund_pending",
      refundRequested: false,
      supplierOrderPlaced: true,
      reason: "supplier_order_already_placed_manual_supplier_cancellation_required",
    };
  }

  if (String(order.payment_status) !== "paid") {
    await supabase
      .from("shop_orders")
      .update({ order_status: "cancelled" })
      .eq("id", args.orderId);

    return {
      orderId: args.orderId,
      status: "cancelled",
      refundRequested: false,
      supplierOrderPlaced: false,
      reason: "payment_not_captured",
    };
  }

  const paymentIntentId =
    typeof order.stripe_payment_intent_id === "string"
      ? order.stripe_payment_intent_id
      : null;

  if (!paymentIntentId) {
    return {
      orderId: args.orderId,
      status: "refund_pending",
      refundRequested: false,
      supplierOrderPlaced: false,
      reason: "payment_intent_missing_manual_refund_required",
    };
  }

  const stripe = getStripeClient();
  const refund = await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      reason: "requested_by_customer",
    },
    {
      idempotencyKey: `shop-order-refund:${args.orderId}`,
    },
  );

  await supabase
    .from("shop_orders")
    .update({
      order_status: "refund_pending",
      refund_id: refund.id,
      refund_requested_at: now,
    })
    .eq("id", args.orderId);

  return {
    orderId: args.orderId,
    status: "refund_pending",
    refundRequested: true,
    supplierOrderPlaced: false,
    reason: null,
  };
}
