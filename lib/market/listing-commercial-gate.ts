import { evaluateChannelListingEligibility, type ChannelListingEligibilityInput } from "./channel-listing-eligibility.ts";
import { assessCommercialTerms } from "./commercial-terms.ts";
import { hasPassedSalesTestGate } from "./sales-test-gate.ts";
import { getSupplierAdapter } from "../procurement/registry.ts";

export type ListingCommercialOverrides = Partial<Pick<
  ChannelListingEligibilityInput,
  "title" | "description" | "inventory" | "inventoryConfirmed" | "orderable" | "salesTestPassed" | "requireSalesTestPass" | "supplierAdapterRegistered"
>>;

/**
 * Shared publication, storefront, and inventory decision. Profit is recomputed
 * from source currency and FX evidence; a stored contribution profit is not used.
 */
export function evaluateShopListingRecord(
  row: Record<string, unknown>,
  imageReachable: boolean | null,
  overrides: ListingCommercialOverrides = {},
): { eligible: boolean; reasons: string[] } {
  const commercial = assessCommercialTerms({
    sellingCurrency: row.currency,
    sourceCurrency: row.source_currency,
    sourceCost: row.source_cost,
    shippingCost: row.shipping_cost,
    sellingPrice: row.selling_price,
    fxRate: row.fx_rate,
    fxObservedAt: row.fx_observed_at,
  });
  const supplierName = typeof row.supplier_name === "string" ? row.supplier_name : "";
  const selection = Array.isArray(row.selection_reasons) ? row.selection_reasons.map(String) : [];
  return evaluateChannelListingEligibility({
    title: overrides.title ?? row.title,
    description: overrides.description ?? row.description,
    imageUrl: row.image_url,
    imageReachable,
    sellingPrice: row.selling_price,
    currency: row.currency,
    sourceCost: row.source_cost,
    shippingCost: row.shipping_cost,
    contributionProfit: commercial.contributionProfit,
    profitCalculable: commercial.profitCalculable,
    currencyMismatch: commercial.currencyMismatch,
    inventory: overrides.inventory !== undefined ? overrides.inventory : row.inventory,
    inventoryConfirmed: overrides.inventoryConfirmed !== undefined ? overrides.inventoryConfirmed : selection.includes("inventory_confirmed"),
    orderable: overrides.orderable !== undefined ? overrides.orderable : row.orderable === true,
    trackingAvailable: row.tracking_available === true,
    supplierProductId: row.supplier_product_id,
    supplierVariantId: row.supplier_variant_id,
    identityLinked: typeof row.identity_method === "string" && row.identity_method.trim().length > 0,
    identityMethod: row.identity_method,
    identityConfidence: row.identity_confidence,
    salesTestPassed: overrides.salesTestPassed ?? hasPassedSalesTestGate(row),
    requireSalesTestPass: overrides.requireSalesTestPass,
    supplierName,
    supplierAdapterRegistered: overrides.supplierAdapterRegistered ?? getSupplierAdapter(supplierName) !== null,
  });
}
