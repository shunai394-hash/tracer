export type DropshipOrderGateInput = {
  vid: string | null;
  quantity: number | null;
  sourceCost: number | null;
  shippingCost: number | null;
  currency: string | null;
  sellingPrice: number | null;
  /** Multiplier from supplier currency to selling currency. Required when currencies differ. */
  sourceFxRateToSelling: number | null;
  addressComplete: boolean | null;
  killSwitchBlocked: boolean;
  /** Supplier-agnostic configuration flag. cjConfigured is retained for compatibility. */
  supplierConfigured?: boolean;
  supplierName?: string | null;
  supplierIdentityStatus?: string | null;
  cjConfigured: boolean;
  liveOrderingEnabled: boolean;
  /** null = inventory level unknown (unknown is never treated as "in stock"). */
  inventoryQty: number | null;
  duplicateOrderExists: boolean;
};
export type DropshipOrderGateResult = {
  missing: string[];
  blocked: string[];
  profitCalculable: boolean;
  estimatedProfit: number | null;
  liveOrderingDisabled: boolean;
  canExecuteLive: boolean;
};

export function isCjSupplierName(value: string | null | undefined): boolean {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "cj" || normalized === "cjdropshipping";
}

export function evaluateDropshipOrderGate(input: DropshipOrderGateInput): DropshipOrderGateResult {
  const missing: string[] = [];
  const blocked: string[] = [];
  if (!input.vid?.trim()) missing.push("variant_unknown");

  if (input.quantity === null || !Number.isFinite(input.quantity)) missing.push("quantity_unknown");
  else if (input.quantity <= 0) blocked.push("quantity_invalid");

  if (input.sourceCost === null) missing.push("source_cost_unknown");
  else if (!Number.isFinite(input.sourceCost) || input.sourceCost < 0) blocked.push("source_cost_invalid");

  if (input.shippingCost === null) missing.push("shipping_cost_unknown");
  else if (!Number.isFinite(input.shippingCost) || input.shippingCost < 0) blocked.push("shipping_cost_invalid");

  if (!input.currency?.trim()) missing.push("currency_unknown");

  if (input.sellingPrice === null) missing.push("selling_price_unknown");
  else if (!Number.isFinite(input.sellingPrice) || input.sellingPrice <= 0) blocked.push("selling_price_invalid");

  if (input.currency && input.sellingPrice !== null && input.sourceFxRateToSelling === null) {
    missing.push("fx_rate_unknown");
  } else if (input.sourceFxRateToSelling !== null &&
    (!Number.isFinite(input.sourceFxRateToSelling) || input.sourceFxRateToSelling <= 0)) {
    blocked.push("fx_rate_invalid");
  }

  if (input.addressComplete === null) missing.push("address_unknown");
  if (input.addressComplete === false) blocked.push("address_incomplete");
  if (input.killSwitchBlocked) blocked.push("kill_switch_active");

  const supplierConfigured = input.supplierConfigured ?? input.cjConfigured;
  if (!supplierConfigured) blocked.push("supplier_not_configured");
  if (isCjSupplierName(input.supplierName) && input.supplierIdentityStatus !== "linked") {
    blocked.push("supplier_identity_unlinked");
  }

  if (input.inventoryQty === null || !Number.isFinite(input.inventoryQty)) {
    missing.push("inventory_unknown");
  } else if (input.inventoryQty < 0) {
    blocked.push("inventory_invalid");
  } else if (input.quantity !== null && Number.isFinite(input.quantity) && input.inventoryQty < input.quantity) {
    blocked.push("insufficient_inventory");
  }

  if (input.duplicateOrderExists) blocked.push("duplicate_order");

  const economics = [input.sourceCost, input.shippingCost, input.sellingPrice, input.sourceFxRateToSelling];
  const profitCalculable = economics.every((value) => value !== null && Number.isFinite(value)) &&
    (input.sourceCost as number) >= 0 &&
    (input.shippingCost as number) >= 0 &&
    (input.sellingPrice as number) > 0 &&
    (input.sourceFxRateToSelling as number) > 0 &&
    input.quantity !== null && Number.isFinite(input.quantity) && input.quantity > 0;

  const estimatedProfit = profitCalculable
    ? ((input.sellingPrice as number) -
      ((input.sourceCost as number) + (input.shippingCost as number)) * (input.sourceFxRateToSelling as number)) *
      (input.quantity as number)
    : null;

  if (estimatedProfit === null || !Number.isFinite(estimatedProfit)) blocked.push("profit_unknown");
  else if (estimatedProfit <= 0) blocked.push("non_positive_profit");

  const liveOrderingDisabled = !input.liveOrderingEnabled;
  const canExecuteLive = missing.length === 0 && blocked.length === 0 && !liveOrderingDisabled;

  return { missing, blocked, profitCalculable, estimatedProfit, liveOrderingDisabled, canExecuteLive };
}

export function verifyDropshipOrderGateInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const base: DropshipOrderGateInput = {
    vid: "v-1", quantity: 2, sourceCost: 10, shippingCost: 3, currency: "USD",
    sellingPrice: 30, sourceFxRateToSelling: 1, addressComplete: true,
    killSwitchBlocked: false, supplierConfigured: true, cjConfigured: true,
    liveOrderingEnabled: true, inventoryQty: 10, duplicateOrderExists: false,
  };
  const cases = [
    { name: "complete_input_can_execute_live", expected: true, actual: (() => { const r = evaluateDropshipOrderGate(base); return r.canExecuteLive && r.estimatedProfit === 34; })() },
    { name: "unlinked_cj_identity_blocks_order", expected: true, actual: evaluateDropshipOrderGate({ ...base, supplierName: "CJ Dropshipping", supplierIdentityStatus: "supply_discovered" }).blocked.includes("supplier_identity_unlinked") },
    { name: "missing_cj_identity_blocks_order", expected: true, actual: evaluateDropshipOrderGate({ ...base, supplierName: "cj", supplierIdentityStatus: null }).blocked.includes("supplier_identity_unlinked") },
    { name: "linked_cj_identity_does_not_add_identity_blocker", expected: true, actual: !evaluateDropshipOrderGate({ ...base, supplierName: "cjdropshipping", supplierIdentityStatus: "linked" }).blocked.includes("supplier_identity_unlinked") },
    { name: "missing_variant_blocks_execution", expected: true, actual: !evaluateDropshipOrderGate({ ...base, vid: null }).canExecuteLive },
    { name: "live_ordering_disabled_blocks_execution_not_data", expected: true, actual: (() => { const r = evaluateDropshipOrderGate({ ...base, liveOrderingEnabled: false }); return !r.canExecuteLive && r.liveOrderingDisabled && r.missing.length === 0 && r.blocked.length === 0; })() },
    { name: "kill_switch_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, killSwitchBlocked: true }).blocked.includes("kill_switch_active") },
    { name: "unknown_fx_is_missing", expected: true, actual: evaluateDropshipOrderGate({ ...base, sourceFxRateToSelling: null }).missing.includes("fx_rate_unknown") },
    { name: "unknown_address_is_missing", expected: true, actual: evaluateDropshipOrderGate({ ...base, addressComplete: null }).missing.includes("address_unknown") },
    { name: "unknown_inventory_is_missing", expected: true, actual: evaluateDropshipOrderGate({ ...base, inventoryQty: null }).missing.includes("inventory_unknown") },
    { name: "insufficient_inventory_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, inventoryQty: 1 }).blocked.includes("insufficient_inventory") },
    { name: "duplicate_order_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, duplicateOrderExists: true }).blocked.includes("duplicate_order") },
    { name: "negative_profit_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, sellingPrice: 10 }).blocked.includes("non_positive_profit") },
    { name: "NaN_quantity_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, quantity: Number.NaN }).canExecuteLive === false },
    { name: "negative_cost_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, sourceCost: -1 }).blocked.includes("source_cost_invalid") },
    { name: "NaN_inventory_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, inventoryQty: Number.NaN }).missing.includes("inventory_unknown") },
    { name: "zero_fx_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, sourceFxRateToSelling: 0 }).blocked.includes("fx_rate_invalid") },
    { name: "infinite_quantity_blocks_execution", expected: true, actual: !evaluateDropshipOrderGate({ ...base, quantity: Number.POSITIVE_INFINITY }).canExecuteLive },
    { name: "negative_shipping_cost_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, shippingCost: -1 }).blocked.includes("shipping_cost_invalid") },
    { name: "negative_inventory_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, inventoryQty: -1 }).blocked.includes("inventory_invalid") },
    { name: "infinite_fx_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, sourceFxRateToSelling: Number.POSITIVE_INFINITY }).blocked.includes("fx_rate_invalid") },
    { name: "zero_selling_price_blocks_execution", expected: true, actual: evaluateDropshipOrderGate({ ...base, sellingPrice: 0 }).blocked.includes("selling_price_invalid") },
    { name: "overflowed_profit_is_blocked", expected: true, actual: evaluateDropshipOrderGate({ ...base, sellingPrice: Number.MAX_VALUE, quantity: Number.MAX_VALUE }).blocked.includes("profit_unknown") },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
