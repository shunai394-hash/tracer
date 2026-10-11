export type ShopOrderLineItem = {
  listingId: string;
  qty: number;
};

export type ShopOrderPaymentMethod = "cash_on_delivery" | "bank_transfer" | "card";

export type ShopOrderItemsValidation =
  | { ok: true; items: ShopOrderLineItem[] }
  | { ok: false; reason: string };

const ALLOWED_PAYMENT_METHODS = new Set<ShopOrderPaymentMethod>([
  "cash_on_delivery",
  "bank_transfer",
  "card",
]);

/** Validate checkout lines before any order is persisted. */
export function validateShopOrderItems(value: unknown): ShopOrderItemsValidation {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: "items_required" };
  }
  if (value.length > 100) {
    return { ok: false, reason: "too_many_items" };
  }

  const items: ShopOrderLineItem[] = [];
  const seenListingIds = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: `item_${index + 1}_invalid` };
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.listingId !== "string" || !row.listingId.trim()) {
      return { ok: false, reason: `item_${index + 1}_listing_id_required` };
    }
    const listingId = row.listingId.trim();
    if (seenListingIds.has(listingId)) return { ok: false, reason: "duplicate_listing_id" };
    seenListingIds.add(listingId);
    if (typeof row.qty !== "number" || !Number.isSafeInteger(row.qty) || row.qty <= 0) {
      return { ok: false, reason: `item_${index + 1}_quantity_invalid` };
    }
    items.push({ listingId, qty: row.qty });
  }
  return { ok: true, items };
}

/** Unknown payment methods must never fall through to a non-card checkout. */
export function normalizeShopOrderPaymentMethod(value: unknown): ShopOrderPaymentMethod | null {
  if (value === undefined || value === null) return "cash_on_delivery";
  if (typeof value !== "string" || !ALLOWED_PAYMENT_METHODS.has(value as ShopOrderPaymentMethod)) return null;
  return value as ShopOrderPaymentMethod;
}
