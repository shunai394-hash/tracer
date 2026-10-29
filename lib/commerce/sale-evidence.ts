export const SALE_EVIDENCE_FIELDS = [
  "supplier",
  "identity",
  "variant",
  "stock",
  "cost",
  "domestic_shipping",
  "profit",
  "minimum_profit",
  "verification",
] as const;

export type SaleEvidenceField = (typeof SALE_EVIDENCE_FIELDS)[number];

export type SaleEvidenceInput = {
  supplierCode?: string | null;
  supplierProductId?: string | null;
  supplierVariantId?: string | null;
  variantSku?: string | null;
  sourceStatus?: string | null;
  stockKnown?: boolean | null;
  inventory?: number | null;
  unitCost?: number | null;
  shippingKnown?: boolean | null;
  shipTo?: string | null;
  trackingSupported?: boolean | null;
  currency?: string | null;
  sellingPrice?: number | null;
  expectedProfit?: number | null;
};

/**
 * Lists every missing sale condition. An empty list is the only pass.
 * This never marks a product sellable by itself.
 */
export function missingSaleEvidence(input: SaleEvidenceInput): SaleEvidenceField[] {
  const missing: SaleEvidenceField[] = [];
  if (!input.supplierCode) missing.push("supplier");
  if (!input.supplierProductId || !input.supplierVariantId) missing.push("identity");
  if (!input.variantSku) missing.push("variant");
  const stockKnown = input.stockKnown === true && Number(input.inventory) > 0;
  if (!stockKnown) missing.push("stock");
  if (!(Number(input.unitCost) > 0)) missing.push("cost");
  const shippingKnown = input.shippingKnown === true && input.shipTo === "JP" && input.trackingSupported === true;
  if (!shippingKnown) missing.push("domestic_shipping");
  const profitKnown = input.currency === "JPY" && Number(input.sellingPrice) > 0 && Number(input.expectedProfit) > 0;
  if (!profitKnown) missing.push("profit");
  // Verification status remains a hard requirement; timestamp age is not.
  // Inventory, destination shipping, and tracking must still be positively evidenced.
  if (input.sourceStatus !== "verified") missing.push("verification");
  return missing;
}
