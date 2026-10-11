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

test("order execution requires paid non-COD order, exact supplier identity, stock, address, positive profit and safe attempt state", () => {
  const base = {
    channel: "shopify",
    externalOrderId: "order-42",
    attemptState: "none",
    paymentStatus: "paid",
    paymentMethod: "card",
    cancellationOrRefundPending: false,
    supplierIdentityVerified: true,
    supplierProductId: "supplier-product-1",
    supplierVariantId: "supplier-variant-1",
    quantity: 2,
    inventoryKnown: true,
    inventoryAvailable: 5,
    sourceCost: 300,
    shippingCost: 100,
    sellingPrice: 1000,
    sourceFxRateToSelling: 1,
    addressComplete: true,
    supplierConfigured: true,
    liveOrderingEnabled: true,
    killSwitchActive: false,
  };
  assert.equal(core.evaluateOrderExecution(base).eligible, true);
  assert.equal(core.evaluateOrderExecution(base).estimatedUnitProfit, 600);

  const cod = core.evaluateOrderExecution({ ...base, paymentMethod: "cod" });
  assert.equal(cod.eligible, false);
  assert.equal(cod.blockers.includes("cash_on_delivery_not_confirmed"), true);

  const unpaid = core.evaluateOrderExecution({ ...base, paymentStatus: "pending" });
  assert.equal(unpaid.blockers.includes("payment_not_confirmed"), true);

  const unknownPaymentMethod = core.evaluateOrderExecution({ ...base, paymentMethod: null });
  assert.equal(unknownPaymentMethod.blockers.includes("payment_method_unknown"), true);

  const missingVariant = core.evaluateOrderExecution({ ...base, supplierVariantId: null });
  assert.equal(missingVariant.blockers.includes("supplier_variant_id_missing"), true);

  const unknownStock = core.evaluateOrderExecution({ ...base, inventoryKnown: false, inventoryAvailable: null });
  assert.equal(unknownStock.blockers.includes("inventory_unknown"), true);

  const insufficientStock = core.evaluateOrderExecution({ ...base, inventoryAvailable: 1 });
  assert.equal(insufficientStock.blockers.includes("insufficient_inventory"), true);

  const negativeProfit = core.evaluateOrderExecution({ ...base, sellingPrice: 400 });
  assert.equal(negativeProfit.blockers.includes("non_positive_unit_profit"), true);

  const invalidNumber = core.evaluateOrderExecution({ ...base, quantity: Number.NaN });
  assert.equal(invalidNumber.blockers.includes("quantity_invalid"), true);

  const killSwitch = core.evaluateOrderExecution({ ...base, killSwitchActive: true });
  assert.equal(killSwitch.blockers.includes("kill_switch_active"), true);

  const duplicate = core.evaluateOrderExecution({ ...base, attemptState: "confirmed" });
  assert.equal(duplicate.blockers.includes("attempt_already_submitted_or_confirmed"), true);

  const ambiguous = core.evaluateOrderExecution({ ...base, attemptState: "unknown" });
  assert.equal(ambiguous.blockers.includes("attempt_ambiguous_or_in_progress_attempt"), true);
});

test("commerce core contracts remain pure and have no network or database dependencies", () => {
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /createSupabaseAdminClient|\.from\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
});
