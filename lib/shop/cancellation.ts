import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getStripeClient } from "@/lib/payments/stripe/client";

const BLOCKED_STATUSES = new Set([
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

  const { data: purchaseOrders, error: purchaseOrdersError } = await supabase
    .from("purchase_orders")
    .select("id,supplier_order_id,status")
    .eq("shop_order_id", args.orderId)
    .eq("fulfillment_kind", "dropship_customer_order");
  if (purchaseOrdersError) throw new Error(purchaseOrdersError.message);

  const purchaseOrderIds = (purchaseOrders ?? []).map((po) => String(po.id));
  const { data: attempts, error: attemptsError } = purchaseOrderIds.length
    ? await supabase
        .from("supplier_order_attempts")
        .select("purchase_order_id,supplier_order_id,state")
        .in("purchase_order_id", purchaseOrderIds)
    : { data: [], error: null };
  if (attemptsError) throw new Error(attemptsError.message);

  const supplierOrderPlaced = Boolean(
    (purchaseOrders ?? []).some((po) => po.supplier_order_id) ||
    (attempts ?? []).some((attempt) => attempt.supplier_order_id),
  );
  // An in-flight/unknown supplier attempt can still create an external order
  // after this request starts. Do not issue an automatic customer refund while
  // that side effect is unresolved.
  const supplierExecutionUncertain = Boolean(
    (attempts ?? []).some((attempt) => ["in_progress", "unknown"].includes(String(attempt.state))) ||
    (purchaseOrders ?? []).some((po) => ["supplier_payment_pending", "supplier_payment_verification_failed"].includes(String(po.status))),
  );

  const now = new Date().toISOString();
  const nextStatus = supplierOrderPlaced || supplierExecutionUncertain
    ? "refund_pending"
    : "cancellation_requested";

  // Compare-and-set against the status read above. If execution/cancellation
  // changed it concurrently, do not continue into Stripe refund processing.
  const { data: cancellationWrite, error: cancellationWriteError } = await supabase
    .from("shop_orders")
    .update({
      order_status: nextStatus,
      cancellation_requested_at: now,
      cancellation_reason: args.reason?.trim() || "customer_requested",
      cancellation_source: "customer",
    })
    .eq("id", args.orderId)
    .eq("order_status", String(order.order_status))
    .select("id,order_status")
    .maybeSingle();
  if (cancellationWriteError) throw new Error(cancellationWriteError.message);
  if (!cancellationWrite) {
    const { data: latestOrder, error: latestOrderError } = await supabase
      .from("shop_orders")
      .select("order_status")
      .eq("id", args.orderId)
      .maybeSingle();
    if (latestOrderError) throw new Error(latestOrderError.message);
    return {
      orderId: args.orderId,
      status: String(latestOrder?.order_status ?? "manual_review"),
      refundRequested: false,
      supplierOrderPlaced,
      reason: "order_status_changed_during_cancellation_manual_reconciliation_required",
    };
  }

  if (supplierOrderPlaced) {
    return {
      orderId: args.orderId,
      status: "refund_pending",
      refundRequested: false,
      supplierOrderPlaced: true,
      reason: "supplier_order_already_placed_manual_supplier_cancellation_required",
    };
  }

  if (supplierExecutionUncertain) {
    return {
      orderId: args.orderId,
      status: "refund_pending",
      refundRequested: false,
      supplierOrderPlaced: false,
      reason: "supplier_execution_in_flight_or_unknown_manual_reconciliation_required",
    };
  }

  if (String(order.payment_status) !== "paid") {
    const { data: cancelledOrder, error: cancelError } = await supabase
      .from("shop_orders")
      .update({ order_status: "cancelled" })
      .eq("id", args.orderId)
      .eq("order_status", "cancellation_requested")
      .select("id")
      .maybeSingle();
    if (cancelError) throw new Error(cancelError.message);
    if (!cancelledOrder) {
      return {
        orderId: args.orderId,
        status: "cancellation_requested",
        refundRequested: false,
        supplierOrderPlaced: false,
        reason: "cancellation_status_changed_manual_reconciliation_required",
      };
    }

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

  const { error: refundPersistError } = await supabase
    .from("shop_orders")
    .update({
      order_status: "refund_pending",
      refund_id: refund.id,
      refund_requested_at: now,
    })
    .eq("id", args.orderId)
    .eq("order_status", "cancellation_requested");

  return {
    orderId: args.orderId,
    status: "refund_pending",
    refundRequested: true,
    supplierOrderPlaced: false,
    reason: refundPersistError
      ? "refund_created_but_order_state_persist_failed_manual_reconciliation_required"
      : null,
  };
}
