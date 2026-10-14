/**
 * Pure CJ order decisions shared by the CJ supplier adapter and its tests.
 * No network, database, or path-alias imports: every function here must be
 * safe to evaluate before any external side effect.
 */

export type CjOrderPreflightInput = {
  orderNumber?: unknown;
  supplierProductId?: unknown;
  supplierVariantId?: unknown;
  quantity?: unknown;
  shippingCountryCode?: unknown;
  shippingProvince?: unknown;
  shippingCity?: unknown;
  shippingAddress?: unknown;
  shippingZip?: unknown;
  shippingPhone?: unknown;
  shippingCustomerName?: unknown;
};

export type CjOrderPreflight = {
  valid: boolean;
  responseCode: string;
  responseMessage: string | null;
};

/** TRACER sells CJ supply only to Japanese recipients (verified CN -> JP freight). */
export const CJ_SUPPORTED_DESTINATIONS = new Set(["JP"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates everything createOrderV2 needs before an attempt row is claimed.
 * A failure here is a definite "not attempted": nothing was sent to CJ.
 */
export function preflightCjOrder(input: CjOrderPreflightInput): CjOrderPreflight {
  const missing: string[] = [];
  const required: Array<[string, unknown]> = [
    ["orderNumber", input.orderNumber],
    ["supplierProductId", input.supplierProductId],
    ["supplierVariantId", input.supplierVariantId],
    ["shippingCountryCode", input.shippingCountryCode],
    ["shippingProvince", input.shippingProvince],
    ["shippingCity", input.shippingCity],
    ["shippingAddress", input.shippingAddress],
    ["shippingZip", input.shippingZip],
    ["shippingPhone", input.shippingPhone],
    ["shippingCustomerName", input.shippingCustomerName],
  ];
  for (const [name, value] of required) if (!text(value)) missing.push(name);
  if (missing.length > 0) {
    return { valid: false, responseCode: "CJ_PREFLIGHT_FIELD_MISSING", responseMessage: missing.join(",") };
  }
  const quantity = typeof input.quantity === "number" ? input.quantity : Number.NaN;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { valid: false, responseCode: "CJ_PREFLIGHT_QUANTITY_INVALID", responseMessage: String(input.quantity) };
  }
  const country = text(input.shippingCountryCode).toUpperCase();
  if (!CJ_SUPPORTED_DESTINATIONS.has(country)) {
    return { valid: false, responseCode: "CJ_PREFLIGHT_DESTINATION_UNSUPPORTED", responseMessage: country };
  }
  return { valid: true, responseCode: "CJ_PREFLIGHT_OK", responseMessage: null };
}

export type CjLogisticOption = { logisticName: string; shippingCost: number; arrivalTime: string | null };

/**
 * The profit gate prices shipping with CJ's cheapest JP quote, so the order
 * must use that same option. Any other choice could exceed the checked cost.
 */
export function selectCjLogistic(options: CjLogisticOption[]): CjLogisticOption | null {
  const usable = options.filter((option) =>
    option.logisticName.trim().length > 0 && Number.isFinite(option.shippingCost) && option.shippingCost > 0,
  );
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => a.shippingCost - b.shippingCost)[0];
}

function normalizePaymentState(value: unknown): "paid" | "unpaid" | "unknown" {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["paid", "paymentcompleted", "paymentsuccess", "completed"].includes(normalized)) return "paid";
  if (["unpaid", "pending", "paymentpending", "created", "unpay", "waitpay"].includes(normalized)) return "unpaid";
  return "unknown";
}

/**
 * Payment is confirmed only by an explicit CJ payment timestamp or payment
 * state on getOrderDetail. Order creation success is never treated as paid.
 */
export function extractCjPaymentConfirmation(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const data = (raw as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return false;
  const row = data as Record<string, unknown>;
  if (typeof row.paymentDate === "string" && row.paymentDate.trim()) return true;
  if (typeof row.paymentDateTime === "number" && Number.isFinite(row.paymentDateTime) && row.paymentDateTime > 0) return true;
  const payment = row.payment && typeof row.payment === "object" ? row.payment as Record<string, unknown> : null;
  return [row.paymentStatus, row.payStatus, row.paymentState, row.payState, payment?.status, payment?.paymentStatus]
    .some((value) => normalizePaymentState(value) === "paid");
}

/** Statuses after which CJ has dispatched or will no longer ship the order. */
export function classifyCjOrderStatus(status: unknown): "pending" | "shipped" | "closed" | "unknown" {
  const value = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (["CREATED", "IN_CART", "UNPAID", "UNSHIPPED", "PENDING", "PROCESSING"].includes(value)) return "pending";
  if (["SHIPPED", "DELIVERED", "COMPLETED"].includes(value)) return "shipped";
  if (["CANCELLED", "CANCELED", "CLOSED", "REFUNDED"].includes(value)) return "closed";
  return "unknown";
}
