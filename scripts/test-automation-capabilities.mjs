import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  canPerformAutomationCapability,
  CRON_CAPABILITIES,
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


const vercelConfig = JSON.parse(readFileSync("vercel.json", "utf8"));
const scheduledPaths = [...new Set((vercelConfig.crons ?? []).map((entry) => entry.path))];
for (const routePath of scheduledPaths) {
  assert.ok(CRON_CAPABILITIES[routePath], `missing capability mapping for scheduled route ${routePath}`);
  const routeFile = `app${routePath}/route.ts`;
  assert.ok(existsSync(routeFile), `missing route source ${routeFile}`);
  const source = readFileSync(routeFile, "utf8");
  assert.ok(
    source.includes(`requireAutomationCapability(request, "${CRON_CAPABILITIES[routePath]}")`),
    `scheduled route ${routePath} does not enforce its declared capability`,
  );
}
for (const mappedPath of Object.keys(CRON_CAPABILITIES)) {
  assert.ok(scheduledPaths.includes(mappedPath), `stale capability mapping not scheduled in vercel.json: ${mappedPath}`);
}

console.log(`automation-capabilities: PASS (${31 + scheduledPaths.length * 3 + Object.keys(CRON_CAPABILITIES).length} assertions; ${scheduledPaths.length} unique Vercel Cron routes covered)`);
