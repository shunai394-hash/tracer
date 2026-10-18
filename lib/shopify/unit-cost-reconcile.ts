export type UnitCostObservation = {
  shopifyUnitCost: number | null;
  shopifyCurrency: string | null;
  supplierUnitCost: number | null;
  supplierCurrency: string | null;
  shippingCost: number | null;
  shippingKnown: boolean;
  sellingPrice: number | null;
  expectedProfit: number | null;
  priceCurrency: string | null;
};

export type UnitCostVerdict = {
  costConfirmed: boolean;
  profitConfirmed: boolean;
  reasons: string[];
};

function positive(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Shopify unit cost must be present and match the supplier cost before profit is treated as confirmed. */
export function judgeUnitCost(input: UnitCostObservation): UnitCostVerdict {
  const reasons: string[] = [];
  if (!positive(input.shopifyUnitCost)) reasons.push("shopify_unit_cost_missing");
  if (!positive(input.supplierUnitCost)) reasons.push("supplier_unit_cost_missing");
  if (input.shopifyCurrency && input.shopifyCurrency !== "JPY") reasons.push("shopify_unit_cost_not_jpy");
  if (input.supplierCurrency && input.supplierCurrency !== "JPY") reasons.push("supplier_unit_cost_not_jpy");
  if (
    positive(input.shopifyUnitCost) && positive(input.supplierUnitCost) &&
    Math.round(Number(input.shopifyUnitCost)) !== Math.round(Number(input.supplierUnitCost))
  ) {
    reasons.push("shopify_unit_cost_differs_from_supplier");
  }
  if (!input.shippingKnown || !positive(input.shippingCost)) reasons.push("domestic_shipping_unconfirmed");
  if (input.priceCurrency !== "JPY" || !positive(input.sellingPrice)) reasons.push("selling_price_unconfirmed");
  if (!positive(input.expectedProfit)) reasons.push("profit_unconfirmed");
  const costConfirmed = !reasons.some((reason) =>
    reason === "shopify_unit_cost_missing" ||
    reason === "supplier_unit_cost_missing" ||
    reason === "shopify_unit_cost_not_jpy" ||
    reason === "supplier_unit_cost_not_jpy" ||
    reason === "shopify_unit_cost_differs_from_supplier");
  const profitConfirmed = costConfirmed && reasons.length === 0;
  return { costConfirmed, profitConfirmed, reasons };
}
