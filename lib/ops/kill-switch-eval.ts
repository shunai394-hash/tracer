export type KillSwitchScope = "global" | "supplier" | "product" | "user";

export type KillSwitchRow = {
  id: string;
  scope: KillSwitchScope;
  scopeKey: string;
  active: boolean;
  reason: string | null;
  createdBy: string | null;
  updatedAt: string;
};

export type KillSwitchContext = {
  supplier?: string | null;
  productId?: string | null;
  userId?: string | null;
};

export type KillSwitchEvaluation = {
  blocked: boolean;
  matched: Array<{ scope: KillSwitchScope; scopeKey: string; reason: string | null }>;
};

/**
 * Pure evaluation: given the currently active switches and a context, decide whether
 * an order/action must be blocked. No DB access so this can run in the invariant suite.
 */
export function evaluateKillSwitches(
  switches: KillSwitchRow[],
  context: KillSwitchContext,
): KillSwitchEvaluation {
  const matched: KillSwitchEvaluation["matched"] = [];

  for (const row of switches) {
    if (!row.active) continue;

    if (row.scope === "global") {
      matched.push({ scope: "global", scopeKey: row.scopeKey, reason: row.reason });
      continue;
    }
    if (row.scope === "supplier" && context.supplier && row.scopeKey === context.supplier) {
      matched.push({ scope: "supplier", scopeKey: row.scopeKey, reason: row.reason });
      continue;
    }
    if (row.scope === "product" && context.productId && row.scopeKey === context.productId) {
      matched.push({ scope: "product", scopeKey: row.scopeKey, reason: row.reason });
      continue;
    }
    if (row.scope === "user" && context.userId && row.scopeKey === context.userId) {
      matched.push({ scope: "user", scopeKey: row.scopeKey, reason: row.reason });
    }
  }

  return { blocked: matched.length > 0, matched };
}

export function verifyKillSwitchInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const now = new Date().toISOString();
  const switches: KillSwitchRow[] = [
    { id: "1", scope: "global", scopeKey: "", active: false, reason: null, createdBy: null, updatedAt: now },
    { id: "2", scope: "supplier", scopeKey: "CJdropshipping", active: true, reason: "supplier delay", createdBy: null, updatedAt: now },
    { id: "3", scope: "product", scopeKey: "prod-1", active: false, reason: null, createdBy: null, updatedAt: now },
  ];

  const globalOff = evaluateKillSwitches(switches, { supplier: "OtherSupplier" });
  const supplierBlocked = evaluateKillSwitches(switches, { supplier: "CJdropshipping" });
  const productInactive = evaluateKillSwitches(switches, { productId: "prod-1" });

  const globalOn: KillSwitchRow[] = [
    { id: "1", scope: "global", scopeKey: "", active: true, reason: "emergency stop", createdBy: null, updatedAt: now },
  ];
  const globalBlocksEverything = evaluateKillSwitches(globalOn, { supplier: "anything" });

  const cases = [
    { name: "no_match_not_blocked", expected: true, actual: globalOff.blocked === false },
    { name: "supplier_switch_blocks_matching_supplier", expected: true, actual: supplierBlocked.blocked === true },
    { name: "inactive_switch_does_not_block", expected: true, actual: productInactive.blocked === false },
    { name: "global_switch_blocks_regardless_of_context", expected: true, actual: globalBlocksEverything.blocked === true },
  ];

  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
