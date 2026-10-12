export type ExistingBaseOrderPaymentState = {
  payment_status?: string;
  order_status?: string;
};

/** Prevent a stale unpaid BASE response from downgrading a previously paid order. */
export function getExistingBaseOrderPaymentPatch(args: {
  existingPaymentStatus: string | null | undefined;
  existingOrderStatus: string | null | undefined;
  paid: boolean;
  canceled: boolean;
}): ExistingBaseOrderPaymentState {
  if (args.canceled) return { payment_status: "failed", order_status: "cancelled" };
  if (args.paid) {
    const patch: ExistingBaseOrderPaymentState = { payment_status: "paid" };
    if (args.existingOrderStatus === "pending_payment" || args.existingOrderStatus === "fulfillment_pending") {
      patch.order_status = "fulfillment_pending";
    }
    return patch;
  }
  if (args.existingPaymentStatus === "paid") return {};
  return { payment_status: "pending", order_status: "pending_payment" };
}
