import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../lib/tracer-core/contracts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const core = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("exact supplier variant identity matches; SKU and title are not identity fallbacks", () => {
  const records = [{ internalProductId: "p1", supplierProductId: "s1", supplierVariantId: "v1", sku: "SKU-1" }];
  assert.equal(core.resolveProductIdentity({ supplierProductId: "s1", supplierVariantId: "v1" }, records).internalProductId, "p1");
  assert.deepEqual(core.resolveProductIdentity({ supplierProductId: "s1", supplierVariantId: null }, records), { status: "unmatched", reason: "missing_external_identity" });
  assert.deepEqual(core.resolveProductIdentity({ supplierProductId: "s2", supplierVariantId: "v2" }, records), { status: "unmatched", reason: "no_exact_match" });
});

test("conflicting exact identities fail closed", () => {
  const records = [{ internalProductId: "p1", supplierProductId: "s1", supplierVariantId: "v1" }, { internalProductId: "p2", supplierProductId: "s1", supplierVariantId: "v1" }];
  assert.deepEqual(core.resolveProductIdentity({ supplierProductId: "s1", supplierVariantId: "v1" }, records), { status: "conflict", reason: "multiple_exact_matches", candidateProductIds: ["p1", "p2"] });
});

test("publication requires Japanese copy, exact supplier variant, positive margin, stock, orderability and tracking", () => {
  const listing = { japaneseTitleValid: true, descriptionValid: true, imageVerified: true, supplierIdentityVerified: true, supplierVariantVerified: true, inventoryKnown: true, inventoryAvailable: 4, orderable: true, trackingAvailable: true, sellingPrice: 1000, landedCost: 500, channelFees: 100, shippingCost: 100 };
  assert.deepEqual(core.evaluatePublication(listing), { eligible: true, blockers: [], expectedUnitMargin: 300 });
  assert.equal(core.evaluatePublication({ ...listing, inventoryKnown: false, inventoryAvailable: null }).blockers.includes("inventory_unknown"), true);
  assert.equal(core.evaluatePublication({ ...listing, inventoryAvailable: 0 }).blockers.includes("inventory_unavailable"), true);
  assert.equal(core.evaluatePublication({ ...listing, orderable: false }).blockers.includes("supplier_not_orderable"), true);
  assert.equal(core.evaluatePublication({ ...listing, trackingAvailable: false }).blockers.includes("tracking_unavailable"), true);
  assert.equal(core.evaluatePublication({ ...listing, landedCost: null }).blockers.includes("cost_or_price_unknown"), true);
  assert.equal(core.evaluatePublication({ ...listing, sellingPrice: 700 }).blockers.includes("non_positive_unit_margin"), true);
  assert.equal(core.evaluatePublication({ ...listing, supplierVariantVerified: false }).blockers.includes("supplier_variant_unverified"), true);
});

test("order execution separately blocks unknown or unavailable supply", () => {
  const orderable = { supplierIdentityVerified: true, supplierVariantVerified: true, inventoryKnown: true, inventoryAvailable: 4, orderable: true, trackingAvailable: true };
  assert.deepEqual(core.evaluateOrderExecution(orderable), { eligible: true, blockers: [] });
  assert.equal(core.evaluateOrderExecution({ ...orderable, inventoryAvailable: 0 }).blockers.includes("inventory_unavailable"), true);
  assert.equal(core.evaluateOrderExecution({ ...orderable, inventoryKnown: false, inventoryAvailable: null }).blockers.includes("inventory_unknown"), true);
  assert.equal(core.evaluateOrderExecution({ ...orderable, orderable: false }).blockers.includes("supplier_not_orderable"), true);
  assert.equal(core.evaluateOrderExecution({ ...orderable, trackingAvailable: false }).blockers.includes("tracking_unavailable"), true);
});

test("submitted/confirmed orders are never blindly resubmitted", () => {
  assert.deepEqual(core.classifyOrderAttempt("base", "order-1", "confirmed"), { action: "skip", reason: "already_submitted_or_confirmed" });
  assert.deepEqual(core.classifyOrderAttempt("shopify", "order-2", "unknown"), { action: "reconcile", reason: "ambiguous_or_in_progress_attempt" });
  assert.deepEqual(core.classifyOrderAttempt("base", "", "none"), { action: "block", reason: "missing_external_order_identity" });
});
