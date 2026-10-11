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
