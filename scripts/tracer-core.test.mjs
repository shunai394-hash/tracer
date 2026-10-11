import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/tracer-core/contracts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const core = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("exact supplier variant identity matches; SKU is not a fallback", () => {
  const records = [{ internalProductId: "p1", supplierProductId: "s1", supplierVariantId: "v1", sku: "SKU-1" }];
  assert.equal(core.resolveProductIdentity({ supplierProductId: "s1", supplierVariantId: "v1" }, records).internalProductId, "p1");
  assert.deepEqual(core.resolveProductIdentity({ supplierProductId: "s1", supplierVariantId: null }, records), {
    status: "unmatched", reason: "missing_external_identity",
  });
  assert.deepEqual(core.resolveProductIdentity({ supplierProductId: "s2", supplierVariantId: "v2" }, records), {
    status: "unmatched", reason: "no_exact_match",
  });
});

test("identity conflict fails closed when one external identity maps to multiple products", () => {
  const records = [
    { internalProductId: "p1", supplierProductId: "s1", supplierVariantId: "v1" },
    { internalProductId: "p2", supplierProductId: "s1", supplierVariantId: "v1" },
  ];
  assert.deepEqual(core.resolveProductIdentity({ supplierProductId: "s1", supplierVariantId: "v1" }, records), {
    status: "conflict", reason: "multiple_exact_matches", candidateProductIds: ["p1", "p2"],
  });
});

test("publication blocks unknown costs and non-positive margin", () => {
  const base = {
    salesTestPassed: true, japaneseTitleValid: true, descriptionValid: true,
    imageVerified: true, supplierIdentityVerified: true, supplierVariantVerified: true,
    inventoryKnown: true, inventoryAvailable: 4, orderable: true, trackingAvailable: true,
    sellingPrice: 1000, landedCost: 500, channelFees: 100, shippingCost: 100,
  };
  assert.equal(core.evaluatePublication(base).eligible, true);
  assert.equal(core.evaluatePublication({ ...base, landedCost: null }).blockers.includes("cost_or_price_unknown"), true);
  assert.equal(core.evaluatePublication({ ...base, sellingPrice: 700 }).blockers.includes("non_positive_unit_margin"), true);
  assert.equal(core.evaluatePublication({ ...base, inventoryAvailable: 0 }).blockers.includes("inventory_unavailable"), true);
});

test("order retries do not resubmit ambiguous, submitted, or confirmed attempts", () => {
  assert.deepEqual(core.classifyOrderAttempt("base", "order-1", "confirmed"), {
    action: "skip", reason: "already_submitted_or_confirmed",
  });
  assert.deepEqual(core.classifyOrderAttempt("shopify", "order-2", "unknown"), {
    action: "reconcile", reason: "ambiguous_or_in_progress_attempt",
  });
  assert.deepEqual(core.classifyOrderAttempt("base", "", "none"), {
    action: "block", reason: "missing_external_order_identity",
  });
});
