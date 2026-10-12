export type ShopifyWebhookOrderValidation =
  | { ok: true; subtotal: number; total: number; currency: string }
  | { ok: false; reason: string };

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateShopifyWebhookOrder(order: Record<string, unknown>): ShopifyWebhookOrderValidation {
  const items = Array.isArray(order.line_items) ? order.line_items as Array<Record<string, unknown>> : [];
  if (!items.length) return { ok: false, reason: "line_items_missing" };

  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object") return { ok: false, reason: `line_item_${index + 1}_invalid` };
    if (!Number.isSafeInteger(item.quantity) || Number(item.quantity) <= 0) {
      return { ok: false, reason: `line_item_${index + 1}_quantity_invalid` };
    }
    const price = finiteNumber(item.price);
    if (price === null || price < 0) return { ok: false, reason: `line_item_${index + 1}_price_invalid` };
    if (item.sku == null || !String(item.sku).trim()) {
      return { ok: false, reason: "listing_sku_missing" };
    }
  }

  const shipping = order.shipping_address && typeof order.shipping_address === "object"
    ? order.shipping_address as Record<string, unknown>
    : null;
  if (!shipping || typeof shipping.address1 !== "string" || !shipping.address1.trim()) {
    return { ok: false, reason: "shipping_address_missing" };
  }

  const subtotal = finiteNumber(order.subtotal_price);
  const total = finiteNumber(order.total_price);
  if (subtotal === null || subtotal < 0 || total === null || total <= 0) {
    return { ok: false, reason: "order_amount_invalid" };
  }
  const currency = typeof order.currency === "string" ? order.currency.trim() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: "order_currency_invalid" };

  return { ok: true, subtotal, total, currency };
}
