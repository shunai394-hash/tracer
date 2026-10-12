import assert from "node:assert/strict";
import { filterSupplierCandidateIds, isNonPhysicalProduct } from "../lib/intelligence/filter-supplier-candidates.ts";

const ids = ["bag", "beauty", "hair", "gift-en", "gift-ja", "category-digital", "car", "missing"];
const rows = [
  { id: "bag", title: "レディース ショルダーバッグ", category: "バッグ" },
  { id: "beauty", title: "Niacinamide Face Serum", category: "skincare" },
  { id: "hair", title: "Fashion Hair Clips for Women", category: "hair accessories" },
  { id: "gift-en", title: "Amazon Gift Card", category: "gift card" },
  { id: "gift-ja", title: "デジタルギフトカード", category: "ギフト" },
  { id: "category-digital", title: "美容 ギフト", category: "digital product voucher" },
  { id: "car", title: "Toyota Prius Floor Mat", category: "automotive" },
];

const result = filterSupplierCandidateIds(ids, rows);
assert.deepEqual(result.supplierCandidateIds, ["bag", "beauty", "hair"]);
assert.equal(result.inputCount, 8);
assert.equal(result.eligibleCount, 3);
assert.equal(result.skippedNonWomenOrNonPhysicalCount, 5);
assert.equal(isNonPhysicalProduct("Amazon   Gift Card"), true);
assert.equal(isNonPhysicalProduct("デジタルギフト", "beauty"), true);
assert.equal(isNonPhysicalProduct("Face Serum", "skincare"), false);

// Missing source rows must fail closed rather than being investigated.
assert.deepEqual(filterSupplierCandidateIds(["missing"], []).supplierCandidateIds, []);
assert.deepEqual(filterSupplierCandidateIds(["bag"], null).supplierCandidateIds, []);

console.log("Supplier candidate filter: women-focused physical products pass; non-physical, irrelevant, and missing rows fail closed.");
