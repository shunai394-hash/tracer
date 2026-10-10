import assert from "node:assert/strict";
import { resolveInventoryRefreshPublication } from "../lib/market/inventory-refresh-publication.ts";

const cases = [
  ["unknown stock blocks listing and hides BASE item", { inventory: null, wasPublished: true, durableSalesTestGatePassed: true }, { inventory: null, orderable: false, published: false, baseStock: 0, baseVisible: false, reason: "inventory_unknown" }],
  ["zero stock blocks listing and hides BASE item", { inventory: 0, wasPublished: true, durableSalesTestGatePassed: true }, { inventory: 0, orderable: false, published: false, baseStock: 0, baseVisible: false, reason: "inventory_zero" }],
  ["positive stock does not republish a previously blocked listing", { inventory: 12, wasPublished: false, durableSalesTestGatePassed: true }, { inventory: 12, orderable: true, published: false, baseStock: 0, baseVisible: false, reason: null }],
  ["positive stock without durable sales gate stays hidden", { inventory: 12, wasPublished: true, durableSalesTestGatePassed: false }, { inventory: 12, orderable: true, published: false, baseStock: 0, baseVisible: false, reason: "sales_test_gate_missing" }],
  ["only previously published gate-passed listing remains visible", { inventory: 12, wasPublished: true, durableSalesTestGatePassed: true }, { inventory: 12, orderable: true, published: true, baseStock: 12, baseVisible: true, reason: null }],
  ["negative stock clamps to zero and blocks publication", { inventory: -3, wasPublished: true, durableSalesTestGatePassed: true }, { inventory: 0, orderable: false, published: false, baseStock: 0, baseVisible: false, reason: "inventory_zero" }],
  ["non-finite stock is treated as unknown", { inventory: Number.NaN, wasPublished: true, durableSalesTestGatePassed: true }, { inventory: null, orderable: false, published: false, baseStock: 0, baseVisible: false, reason: "inventory_unknown" }],
];
for (const [name, input, expected] of cases) assert.deepEqual(resolveInventoryRefreshPublication(input), expected, name);
console.log("PASS: " + cases.length + " inventory refresh publication policy regression cases");
