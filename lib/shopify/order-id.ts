/**
 * Shopify identifies an order both as a REST numeric id ("1234") and as an
 * Admin GraphQL GID ("gid://shopify/Order/1234"). shop_orders.shopify_order_id
 * stores the GID; lookups also match the legacy numeric form so an order seen
 * by both the REST webhook and the GraphQL poller is imported only once.
 *
 * Pure module: no path-alias imports.
 */

const ORDER_GID_PREFIX = "gid://shopify/Order/";

/** Numeric tail of a Shopify order id, or null when it is not a Shopify order id. */
export function shopifyOrderNumericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  const tail = text.startsWith(ORDER_GID_PREFIX) ? text.slice(ORDER_GID_PREFIX.length) : text;
  return /^[1-9][0-9]*$/.test(tail) ? tail : null;
}

/** Canonical stored form (GID), or null for anything that is not a Shopify order id. */
export function canonicalShopifyOrderId(value: unknown): string | null {
  const numeric = shopifyOrderNumericId(value);
  return numeric ? `${ORDER_GID_PREFIX}${numeric}` : null;
}

/** Every stored form of one order, for duplicate lookups. */
export function shopifyOrderIdForms(value: unknown): string[] {
  const numeric = shopifyOrderNumericId(value);
  return numeric ? [`${ORDER_GID_PREFIX}${numeric}`, numeric] : [];
}
