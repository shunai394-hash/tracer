/**
 * CJ and Super Delivery stay unsellable until an order, payment-confirmation,
 * and tracking path is actually connected. The registry refuses both names,
 * and createCJOrderV2 has no caller. Do not infer those capabilities from
 * inventory, freight, or a hardcoded flag.
 */
const CLOSED_SUPPLIERS = new Set([
  "cj",
  "cjdropshipping",
  "cj dropshipping",
  "superdelivery",
  "super delivery",
]);

export function normalizeCommerceSupplierName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isClosedSupplierFulfillment(value: unknown): boolean {
  return CLOSED_SUPPLIERS.has(normalizeCommerceSupplierName(value));
}

export function cjSellabilityBlockReasons(input: { adapterRegistered: boolean }): string[] {
  const reasons = [
    "cj_order_api_not_connected",
    "cj_payment_confirmation_not_connected",
    "cj_tracking_sync_not_connected",
  ];
  if (!input.adapterRegistered) reasons.unshift("cj_supplier_adapter_not_registered");
  return reasons;
}
