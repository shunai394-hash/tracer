export type ShopifyOrderLineAmounts = {
  quantity: number;
  unitPrice: number;
};

export type ShopifyOrderFinancialValidation =
  | {
      ok: true;
      currency: string;
      subtotal: number;
      total: number;
      lineAmounts: ShopifyOrderLineAmounts[];
    }
  | {
      ok: false;
      reason:
        | "shopify_order_currency_missing"
        | "shopify_order_totals_invalid"
        | "shopify_order_line_amounts_invalid";
    };

function amount(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Shopify order totals are in order.currency, not necessarily presentment_currency.
 * Require explicit financial evidence before persisting order or line-item rows.
 */
export function validateShopifyOrderFinancials(
  order: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
): ShopifyOrderFinancialValidation {
  const currency =
    typeof order.currency === "string" ? order.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, reason: "shopify_order_currency_missing" };
  }

  const subtotal = amount(order.subtotal_price);
  const total = amount(order.total_price);
  if (subtotal === null || total === null) {
    return { ok: false, reason: "shopify_order_totals_invalid" };
  }

  const lineAmounts: ShopifyOrderLineAmounts[] = [];
  for (const item of items) {
    const quantityValue = item.quantity;
    const quantity = amount(quantityValue);
    const unitPrice = amount(item.price);
    if (
      quantity === null ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      unitPrice === null
    ) {
      return { ok: false, reason: "shopify_order_line_amounts_invalid" };
    }
    lineAmounts.push({ quantity, unitPrice });
  }

  return { ok: true, currency, subtotal, total, lineAmounts };
}
