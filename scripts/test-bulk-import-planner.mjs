import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadTs(path, transform = (source) => source) {
  const source = transform(await readFile(new URL(path, import.meta.url), "utf8"));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const core = await loadTs("../lib/tracer-core/contracts.ts");
globalThis.__tracerBulkCore = core;
const planner = await loadTs("../lib/tracer-core/bulk-import.ts", (source) =>
  source.replace('import { evaluatePublication, type PublicationEvidence } from "./contracts";',
    "const { evaluatePublication } = globalThis.__tracerBulkCore;")
);

const valid = (productId, supplierProductId, supplierVariantId) => ({
  productId, supplierProductId, supplierVariantId,
  evidence: {
    salesTestPassed: true, japaneseTitleValid: true, descriptionValid: true,
    imageVerified: true, supplierIdentityVerified: true, supplierVariantVerified: true,
    inventoryKnown: true, inventoryAvailable: 8, orderable: true, trackingAvailable: true,
    sellingPrice: 2000, landedCost: 800, channelFees: 200, shippingCost: 300,
  },
});

test("eligible candidates are selected in deterministic order and plan is dry-run only", () => {
  const result = planner.planBulkCatalogImport([
    valid("p1", "s1", "v1"), valid("p2", "s2", "v2"),
  ], 1);
  assert.deepEqual(result.selectedProductIds, ["p1"]);
  assert.equal(result.counts.eligible, 2);
  assert.equal(result.counts.selected, 1);
  assert.equal(result.counts.targetShortfall, 0);
  assert.equal(result.writeMode, "dry_run_only");
});

test("unknown stock, unknown cost, and non-positive margin are blocked", () => {
  const unknownStock = valid("p1", "s1", "v1");
  unknownStock.evidence.inventoryKnown = false;
  const unknownCost = valid("p2", "s2", "v2");
  unknownCost.evidence.landedCost = null;
  const badMargin = valid("p3", "s3", "v3");
  badMargin.evidence.sellingPrice = 100;
  const result = planner.planBulkCatalogImport([unknownStock, unknownCost, badMargin]);
  assert.equal(result.counts.eligible, 0);
  assert.equal(result.rejected.length, 3);
  assert.ok(result.rejected[0].blockers.includes("inventory_unknown"));
  assert.ok(result.rejected[1].blockers.includes("cost_or_price_unknown"));
  assert.ok(result.rejected[2].blockers.includes("non_positive_unit_margin"));
});

test("every occurrence of a duplicated product ID or supplier variant is blocked", () => {
  const result = planner.planBulkCatalogImport([
    valid("p1", "s1", "v1"),
    valid("p1", "s2", "v2"),
    valid("p2", "s3", "v3"),
    valid("p3", "s3", "v3"),
  ]);
  assert.deepEqual(result.duplicateProductIds, ["p1"]);
  assert.deepEqual(result.duplicateSupplierVariants, ["s3::v3"]);
  assert.equal(result.counts.eligible, 0);
  assert.equal(result.rejected.length, 4);
  assert.ok(result.rejected.filter((row) => row.productId === "p1" && row.blockers.includes("duplicate_internal_product_id")).length === 2);
  assert.ok(result.rejected.some((row) => row.productId === "p2" && row.blockers.includes("duplicate_supplier_variant")));
  assert.ok(result.rejected.some((row) => row.productId === "p3" && row.blockers.includes("duplicate_supplier_variant")));
});

test("limit is bounded to 1200 and missing supplier variant fails closed", () => {
  const missing = valid("p1", "s1", "");
  const result = planner.planBulkCatalogImport([missing, valid("p2", "s2", "v2")], 99999);
  assert.equal(result.requestedLimit, 1200);
  assert.equal(result.counts.eligible, 1);
  assert.ok(result.rejected[0].blockers.includes("supplier_product_or_variant_id_missing"));
});

test("target shortfall reports actual evidence gap rather than pretending to reach 1200", () => {
  const result = planner.planBulkCatalogImport([valid("p1", "s1", "v1")], 1200);
  assert.equal(result.counts.selected, 1);
  assert.equal(result.counts.targetShortfall, 1199);
});
