import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  canPerformAutomationCapability,
  CRON_CAPABILITIES,
  PROTECTED_AUTOMATION_ENDPOINTS,
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
];

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


for (const [routePath, capability] of Object.entries(PROTECTED_AUTOMATION_ENDPOINTS)) {
  const routeFile = `app${routePath}/route.ts`;
  assert.ok(existsSync(routeFile), `missing protected endpoint source ${routeFile}`);
  const source = readFileSync(routeFile, "utf8");
  assert.ok(
    source.includes(`requireAutomationCapability(request, "${capability}")`),
    `protected write endpoint ${routePath} does not enforce ${capability}`,
  );
}


for (const workflowPath of [
  ".github/workflows/tracer-direct-900.yml",
  ".github/workflows/tracer-production-smoke.yml",
  ".github/workflows/tracer-build-1000.yml",
  ".github/workflows/tracer-expand-1000.yml",
  ".github/workflows/tracer-publish-cj-now.yml",
  ".github/workflows/tracer-run-sales-test-now.yml",
]) {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.ok(!/^  push:/m.test(workflow), `production write workflow must not run automatically on push: ${workflowPath}`);
  assert.ok(workflow.includes("allow_production_writes"), `missing explicit production-write approval input: ${workflowPath}`);
  assert.ok(workflow.includes("inputs.allow_production_writes == true"), `missing explicit job approval guard: ${workflowPath}`);
}
const shopifySyncRoute = readFileSync("app/api/admin/shopify/sync/route.ts", "utf8");
assert.ok(shopifySyncRoute.includes('requireAutomationCapability(request, "read")'), "Shopify dry-run must require an explicit diagnostic/live mode");
const directRunner = readFileSync("scripts/direct-900-gate.ts", "utf8");
assert.ok(directRunner.includes("evaluateAutomationCapability"), "direct production runner must enforce the capability policy before work");

console.log(`automation-capabilities: PASS; ${scheduledPaths.length} scheduled routes and ${Object.keys(PROTECTED_AUTOMATION_ENDPOINTS).length} additional write endpoints covered`);
