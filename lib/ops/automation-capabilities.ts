export type AutomationMode = "disabled" | "diagnostic" | "writes_enabled";
export type AutomationCapability =
  | "read"
  | "database_write"
  | "channel_write"
  | "supplier_order"
  | "internal_fulfillment";

export type AutomationDecision = {
  allowed: boolean;
  reason: "allowed" | "mode_missing" | "mode_invalid" | "disabled" | "diagnostic_read_only" | "global_stop";
};

const VALID_MODES = new Set<AutomationMode>(["disabled", "diagnostic", "writes_enabled"]);
const WRITE_CAPABILITIES = new Set<AutomationCapability>([
  "database_write",
  "channel_write",
  "supplier_order",
  "internal_fulfillment",
]);

/**
 * Parse an explicit automation mode. Missing and unknown values fail closed;
 * do not treat a missing env var as permission to execute writes.
 */
export function parseAutomationMode(value: string | undefined | null): AutomationMode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return VALID_MODES.has(normalized as AutomationMode) ? (normalized as AutomationMode) : null;
}

/**
 * Pure policy decision. This function performs no IO and must be used by
 * route/helper guards before invoking any side-effecting function.
 */
export function evaluateAutomationCapability(input: {
  mode: AutomationMode | null;
  capability: AutomationCapability;
  globalStop?: boolean;
}): AutomationDecision {
  if (input.globalStop) return { allowed: false, reason: "global_stop" };
  if (input.mode === null) {
    return { allowed: false, reason: "mode_missing" };
  }
  if (input.mode === "disabled") {
    return { allowed: false, reason: "disabled" };
  }
  if (input.mode === "diagnostic" && WRITE_CAPABILITIES.has(input.capability)) {
    return { allowed: false, reason: "diagnostic_read_only" };
  }
  return { allowed: true, reason: "allowed" };
}

/** Convenience predicate for tests and call sites that only need a boolean. */
export function canPerformAutomationCapability(input: {
  mode: AutomationMode | null;
  capability: AutomationCapability;
  globalStop?: boolean;
}): boolean {
  return evaluateAutomationCapability(input).allowed;
}


/** Every Vercel-scheduled route must declare the strongest capability it needs. */
export const CRON_CAPABILITIES = {
  "/api/cron/market-sourcing": "database_write",
  "/api/cron/supplier-investigation": "database_write",
  "/api/cron/cj-variant-repair": "database_write",
  "/api/cron/cj-identity-reverify": "database_write",
  "/api/cron/orosy-bulk-import": "channel_write",
  "/api/cron/sales-test-publication": "channel_write",
  "/api/cron/shopify-publish": "channel_write",
  "/api/cron/inventory-refresh": "channel_write",
  "/api/cron/demand-match": "database_write",
  "/api/cron/intelligence": "channel_write",
  "/api/cron/base-orders": "internal_fulfillment",
  "/api/cron/dropship-execution": "supplier_order",
  "/api/cron/shopify-orders": "supplier_order",
  "/api/cron/supplier-reconciliation": "database_write",
  "/api/cron/shopify-fulfillment": "channel_write",
  "/api/cron/supplier-orders": "database_write",
  "/api/cron/newfind-retry": "channel_write",
  "/api/cron/supply-first": "database_write",
  "/api/cron/patrol-ai": "channel_write",
} as const satisfies Record<string, AutomationCapability>;
