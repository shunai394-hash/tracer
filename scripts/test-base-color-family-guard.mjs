import assert from "node:assert/strict";
import { getBaseColorFamilyBlockedIds } from "../lib/channels/base-color-family.ts";

const rows = [
  { id: "red", supplierProductId: "supplier-family-1" },
  { id: "blue", supplierProductId: "supplier-family-1" },
  { id: "single", supplierProductId: "supplier-single" },
  { id: "blank-a", supplierProductId: null },
  { id: "blank-b", supplierProductId: null },
  { id: "merchant", supplierProductId: "supplier-family-2" },
  { id: "merchant-sibling", supplierProductId: "supplier-family-2" },
];
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds(rows, new Set(["merchant"]))].sort(),
  ["blue", "merchant-sibling", "red"],
);
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds([{ id: "one", supplierProductId: "exact-id" }])],
  [],
);
console.log("BASE color-family publication guard: 2 scenarios passed");
