import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASE_VARIATION_IMAGE_BINDING, getBaseColorFamilyBlockedIds } from "../lib/channels/base-color-family.ts";

const rows = [
  { id: "red", supplierCode: "cj", supplierProductId: "supplier-family-1" },
  { id: "blue", supplierCode: "cj", supplierProductId: "supplier-family-1" },
  { id: "single", supplierCode: "cj", supplierProductId: "supplier-single" },
  { id: "blank-a", supplierCode: "cj", supplierProductId: null },
  { id: "blank-b", supplierCode: "cj", supplierProductId: null },
  { id: "merchant", supplierCode: "cj", supplierProductId: "supplier-family-2" },
  { id: "merchant-sibling", supplierCode: "cj", supplierProductId: "supplier-family-2" },
];
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds(rows, new Set(["merchant"]))].sort(),
  ["blue", "merchant-sibling", "red"],
);
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds([{ id: "one", supplierCode: "cj", supplierProductId: "exact-id" }])],
  [],
);
assert.deepEqual(
  [...getBaseColorFamilyBlockedIds([
    { id: "cj-red", supplierCode: "cj", supplierProductId: "same-id" },
    { id: "cj-blue", supplierCode: "cj", supplierProductId: "same-id" },
    { id: "other", supplierCode: "other-supplier", supplierProductId: "same-id" },
  ])].sort(),
  ["cj-blue", "cj-red"],
  "different supplier namespaces must never be grouped as one color family",
);
assert.equal(BASE_VARIATION_IMAGE_BINDING, "unsupported");
const baseClient = readFileSync(new URL("../lib/channels/base.ts", import.meta.url), "utf8");
assert.doesNotMatch(baseClient, /variation_image|variationImage/);
const imageInput = baseClient.slice(baseClient.indexOf("export async function addBaseItemImage"));
assert.match(imageInput, /image_no/);
assert.doesNotMatch(imageInput.slice(0, 700), /variation_id/);
const editInput = baseClient.slice(baseClient.indexOf("export async function editBaseItem"), baseClient.indexOf("export async function setBaseItemListOrder"));
assert.match(editInput, /variation_id\\[" \\+ index \\]/);
assert.match(editInput, /variation_stock\\[" \\+ index \\]/);
assert.match(editInput, /variation_identifier\\[" \\+ index \\]/);
assert.match(editInput, /BASE_VARIATION_STOCK_TOTAL_MISMATCH/);
assert.match(editInput, /BASE_VARIATION_IDENTIFIER_DUPLICATE/);

console.log("BASE color-family publication guard: 4 scenarios passed");
