import assert from "node:assert/strict";
import {
  canPerformAutomationCapability,
  evaluateAutomationCapability,
  parseAutomationMode,
} from "../lib/ops/automation-capabilities.ts";

assert.equal(parseAutomationMode(undefined), null);
assert.equal(parseAutomationMode(""), null);
assert.equal(parseAutomationMode("unknown"), null);
assert.equal(parseAutomationMode(" DIAGNOSTIC "), "diagnostic");
assert.equal(parseAutomationMode("writes_enabled"), "writes_enabled");
assert.equal(parseAutomationMode("disabled"), "disabled");

const capabilities = [
  "read",
  "database_write",
  "channel_write",
  "supplier_order",
  "internal_fulfillment",
] as const;

for (const capability of capabilities) {
  assert.equal(canPerformAutomationCapability({ mode: null, capability }), false);
  assert.equal(canPerformAutomationCapability({ mode: "disabled", capability }), false);
  assert.equal(canPerformAutomationCapability({ mode: "writes_enabled", capability, globalStop: true }), false);
}

assert.equal(canPerformAutomationCapability({ mode: "diagnostic", capability: "read" }), true);
assert.equal(canPerformAutomationCapability({ mode: "diagnostic", capability: "database_write" }), false);
assert.equal(canPerformAutomationCapability({ mode: "diagnostic", capability: "channel_write" }), false);
assert.equal(canPerformAutomationCapability({ mode: "diagnostic", capability: "supplier_order" }), false);
assert.equal(canPerformAutomationCapability({ mode: "diagnostic", capability: "internal_fulfillment" }), false);

for (const capability of capabilities) {
  assert.equal(canPerformAutomationCapability({ mode: "writes_enabled", capability }), true);
}

assert.deepEqual(
  evaluateAutomationCapability({ mode: "diagnostic", capability: "supplier_order" }),
  { allowed: false, reason: "diagnostic_read_only" },
);

console.log("automation-capabilities: PASS (31 assertions)");
