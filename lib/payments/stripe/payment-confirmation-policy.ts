/**
 * Only Stripe's explicit "paid" status confirms a checkout payment.
 * "unpaid", "no_payment_required", missing, and unknown values fail closed.
 */
export function isStripePaymentConfirmed(paymentStatus: unknown): boolean {
  return paymentStatus === "paid";
}
