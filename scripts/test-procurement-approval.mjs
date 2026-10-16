import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PROCUREMENT_APPROVAL_EVENT_TYPE,
  PROCUREMENT_APPROVAL_MAX_AGE_MS,
  buildProcurementApprovalDetail,
  evaluateProcurementApproval,
  isProcurementApprovalRequired,
  procurementApprovalEventKey,
} from "../lib/commerce/procurement-approval.ts";

let cases = 0;
const check = (name, fn) => { fn(); cases += 1; };

const target = { id: "11111111-1111-4111-8111-111111111111", supplierCode: "cj", supplierProductId: "1234567890123", supplierVariantId: "9876543210987", quantity: 1 };
const now = Date.parse("2026-10-17T00:00:00Z");
const event = (detail, extra = {}) => ({ event_type: PROCUREMENT_APPROVAL_EVENT_TYPE, status: "ok", detail, ...extra });
const approved = buildProcurementApprovalDetail(target, "owner", new Date(now - 60_000));

check("approval is required by default and only '0' disables it", () => {
  assert.equal(isProcurementApprovalRequired({}), true);
  assert.equal(isProcurementApprovalRequired({ COMMERCE_PROCUREMENT_REQUIRE_APPROVAL: "1" }), true);
  assert.equal(isProcurementApprovalRequired({ COMMERCE_PROCUREMENT_REQUIRE_APPROVAL: "false" }), true);
  assert.equal(isProcurementApprovalRequired({ COMMERCE_PROCUREMENT_REQUIRE_APPROVAL: "0" }), false);
});
check("event key is per procurement row", () => {
  assert.equal(procurementApprovalEventKey(target.id), `procurement_approval:${target.id}`);
});
check("missing approval blocks", () => {
  assert.deepEqual(evaluateProcurementApproval(target, null, now), { approved: false, reason: "approval_missing" });
});
check("matching fresh approval passes", () => {
  assert.deepEqual(evaluateProcurementApproval(target, event(approved), now), { approved: true });
});
check("request events and non-ok events are not approvals", () => {
  assert.equal(evaluateProcurementApproval(target, event(approved, { event_type: "procurement_approval_requested" }), now).approved, false);
  assert.equal(evaluateProcurementApproval(target, event(approved, { status: "pending" }), now).approved, false);
});
check("approval bound to other content is rejected", () => {
  for (const change of [{ quantity: 2 }, { supplierVariantId: "1111111111111" }, { supplierProductId: "2222222222222" }, { procurementOrderId: "22222222-2222-4222-8222-222222222222" }, { supplierCode: "dsers" }]) {
    assert.deepEqual(evaluateProcurementApproval(target, event({ ...approved, ...change }), now), { approved: false, reason: "approval_content_mismatch" });
  }
});
check("expired, future-dated or anonymous approvals are rejected", () => {
  assert.equal(evaluateProcurementApproval(target, event({ ...approved, approvedAt: new Date(now - PROCUREMENT_APPROVAL_MAX_AGE_MS - 1).toISOString() }), now).reason, "approval_expired");
  assert.equal(evaluateProcurementApproval(target, event({ ...approved, approvedAt: new Date(now + 60 * 60_000).toISOString() }), now).reason, "approval_invalid");
  assert.equal(evaluateProcurementApproval(target, event({ ...approved, approvedBy: "" }), now).reason, "approval_invalid");
  assert.equal(evaluateProcurementApproval(target, event({ ...approved, approvedAt: "not-a-date" }), now).reason, "approval_invalid");
});

const route = await readFile(new URL("../app/api/cron/commerce-procurement/route.ts", import.meta.url), "utf8");
check("canonical procurement checks dry-run, kill switch and approval before claiming", () => {
  const dryRun = route.indexOf("isSupplierDryRunEnabled()");
  const kill = route.indexOf("checkKillSwitch({ supplier: \"cj\" })");
  const approval = route.indexOf("evaluateProcurementApproval(target, approvalEvent)");
  const claim = route.indexOf(".update({ status: \"processing\"");
  const create = route.indexOf("cjSupplierAdapter.createOrder(input)");
  for (const index of [dryRun, kill, approval, claim, create]) assert.ok(index > 0);
  assert.ok(dryRun < claim && kill < claim && approval < claim && claim < create);
  assert.match(route, /if \(approvalRequired\) \{/);
  assert.match(route, /awaiting_human_approval/);
});

const legacy = await readFile(new URL("../lib/ordering/supplier-execution.ts", import.meta.url), "utf8");
check("legacy ordering requires human confirmation even with auto-ordering on", () => {
  assert.match(legacy, /if \(!po\.human_confirmed_at && \(!autoOrdering \|\| isProcurementApprovalRequired\(\)\)\)/);
});

const admin = await readFile(new URL("../app/api/admin/procurement/approvals/route.ts", import.meta.url), "utf8");
check("approval route is authenticated, dry-run by default and never orders", () => {
  assert.match(admin, /requireAutomationAuth\(request\)/);
  assert.match(admin, /const apply = body\.apply === true;/);
  assert.doesNotMatch(admin, /createOrder|executeLivePurchaseOrder|executeSupplierPurchaseOrder/);
  assert.doesNotMatch(admin, /shippingCustomerName|address\.phone|address1|customer_name/);
});

const status = await readFile(new URL("../app/api/admin/commerce/status/route.ts", import.meta.url), "utf8");
check("commerce status route is authenticated and read-only", () => {
  assert.match(status, /requireAutomationAuth\(request\)/);
  assert.doesNotMatch(status, /\.(insert|update|upsert|delete)\(/);
  assert.doesNotMatch(status, /customer_name|shipping_address/);
});
const statusWorkflow = await readFile(new URL("../.github/workflows/tracer-commerce-status-readonly.yml", import.meta.url), "utf8");
check("status workflow only issues GET requests", () => {
  assert.doesNotMatch(statusWorkflow, /-X (POST|PUT|PATCH|DELETE)|--data|-d '/);
});

check("both pipelines refuse a supplier purchase the other pipeline already placed or approved", () => {
  const conflict = route.indexOf("legacyPurchaseConflictForCommerceOrder(");
  const claim = route.indexOf(".update({ status: \"processing\"");
  assert.ok(conflict > 0 && conflict < claim);
  assert.match(legacy, /commerceProcurementConflictForShopOrder\(String\(po\.shop_order_id\)\)/);
  assert.match(admin, /cross_pipeline_duplicate/);
});
const guard = await readFile(new URL("../lib/commerce/cross-pipeline-guard.ts", import.meta.url), "utf8");
check("cross-pipeline guard fails closed on lookup errors and matches both Shopify id forms", () => {
  assert.match(guard, /legacy_order_lookup_failed/);
  assert.match(guard, /return \{ conflict: true, reason: "legacy_purchase_lookup_failed:/);
  assert.match(guard, /gid:\/\/shopify\/Order\/\$\{numeric\}/);
});

console.log(`procurement approval gate: ${cases} cases passed`);
