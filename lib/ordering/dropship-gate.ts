export type DropshipOrderGateInput = {
  vid: string | null;
  quantity: number | null;
  sourceCost: number | null;
  shippingCost: number | null;
  currency: string | null;
  sellingPrice: number | null;
  addressComplete: boolean | null;
  killSwitchBlocked: boolean;
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

export function evaluateDropshipOrderGate(
  input: DropshipOrderGateInput,
): DropshipOrderGateResult {
  const missing: string[] = [];
  const blocked: string[] = [];

  if (!input.vid) missing.push("variant_unknown");
  if (input.quantity === null || input.quantity <= 0) missing.push("quantity_unknown");
  if (input.sourceCost === null) missing.push("source_cost_unknown");
  if (input.shippingCost === null) missing.push("shipping_cost_unknown");
  if (!input.currency) missing.push("currency_unknown");
  if (input.sellingPrice === null) missing.push("selling_price_unknown");
  if (input.addressComplete === null) missing.push("address_unknown");
  if (input.addressComplete === false) blocked.push("address_incomplete");
  if (input.killSwitchBlocked) blocked.push("kill_switch_active");
  if (!input.cjConfigured) blocked.push("cj_not_configured");
  if (input.inventoryQty === null) {
    missing.push("inventory_unknown");
  } else if (input.quantity !== null && input.inventoryQty < input.quantity) {
    blocked.push("insufficient_inventory");
  }
  if (input.duplicateOrderExists) blocked.push("duplicate_order");

  const profitCalculable =
    input.sourceCost !== null && input.shippingCost !== null && input.sellingPrice !== null;

  const estimatedProfit =
    profitCalculable && input.quantity !== null
      ? (input.sellingPrice! - input.sourceCost! - input.shippingCost!) * input.quantity
      : null;

  const liveOrderingDisabled = !input.liveOrderingEnabled;

  const canExecuteLive =
    missing.length === 0 &&
    blocked.length === 0 &&
    !liveOrderingDisabled;

  return {
    missing,
    blocked,
    profitCalculable,
    estimatedProfit,
    liveOrderingDisabled,
    canExecuteLive,
  };
}

export function verifyDropshipOrderGateInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const base: DropshipOrderGateInput = {
    vid: "v-1",
    quantity: 2,
    sourceCost: 10,
    shippingCost: 3,
    currency: "USD",
    sellingPrice: 30,
    addressComplete: true,
    killSwitchBlocked: false,
    cjConfigured: true,
    liveOrderingEnabled: true,
    inventoryQty: 10,
    duplicateOrderExists: false,
  };

  const ready = evaluateDropshipOrderGate(base);
  const missingVid = evaluateDropshipOrderGate({ ...base, vid: null });
  const liveOff = evaluateDropshipOrderGate({ ...base, liveOrderingEnabled: false });
  const killed = evaluateDropshipOrderGate({ ...base, killSwitchBlocked: true });
  const unknownAddress = evaluateDropshipOrderGate({ ...base, addressComplete: null });
  const unknownInventory = evaluateDropshipOrderGate({ ...base, inventoryQty: null });
  const insufficientInventory = evaluateDropshipOrderGate({ ...base, inventoryQty: 1, quantity: 2 });
  const duplicate = evaluateDropshipOrderGate({ ...base, duplicateOrderExists: true });

  const cases = [
    {
      name: "complete_input_can_execute_live",
      expected: true,
      actual: ready.canExecuteLive === true && ready.estimatedProfit === (30 - 10 - 3) * 2,
    },
    {
      name: "missing_variant_blocks_execution",
      expected: true,
      actual: missingVid.canExecuteLive === false && missingVid.missing.includes("variant_unknown"),
    },
    {
      name: "live_ordering_disabled_blocks_execution_not_data",
      expected: true,
      actual:
        liveOff.canExecuteLive === false &&
        liveOff.liveOrderingDisabled === true &&
        liveOff.missing.length === 0 &&
        liveOff.blocked.length === 0,
    },
    {
      name: "kill_switch_blocks_execution",
      expected: true,
      actual: killed.canExecuteLive === false && killed.blocked.includes("kill_switch_active"),
    },
    {
      name: "unknown_address_is_missing_not_blocked",
      expected: true,
      actual:
        unknownAddress.canExecuteLive === false &&
        unknownAddress.missing.includes("address_unknown"),
    },
    {
      name: "unknown_inventory_blocks_as_missing_never_treated_as_in_stock",
      expected: true,
      actual:
        unknownInventory.canExecuteLive === false &&
        unknownInventory.missing.includes("inventory_unknown"),
    },
    {
      name: "insufficient_inventory_blocks_execution",
      expected: true,
      actual:
        insufficientInventory.canExecuteLive === false &&
        insufficientInventory.blocked.includes("insufficient_inventory"),
    },
    {
      name: "duplicate_order_blocks_execution",
      expected: true,
      actual: duplicate.canExecuteLive === false && duplicate.blocked.includes("duplicate_order"),
    },
  ];

  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
