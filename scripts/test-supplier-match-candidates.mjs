import assert from "node:assert/strict";
import { rankSupplierMatchCandidates } from "../lib/market/supplier-match-candidates.ts";

const target = {
  supplierProductId: "CJ-100",
  supplierVariantId: "CJ-100-BLK-M",
  title: "レディース ショルダーバッグ ブラック Mサイズ",
  imageUrl: "https://cdn.example.test/bag-black.jpg",
  specs: { color: "ブラック", size: "M", material: "合成皮革" },
};

const exact = rankSupplierMatchCandidates(target, [
  { id: "right", supplierProductId: "CJ-100", supplierVariantId: "CJ-100-BLK-M", title: "ショルダーバッグ", imageUrl: "https://cdn.example.test/bag-black.jpg", specs: { color: "ブラック", size: "M" } },
  { id: "wrong", supplierProductId: "CJ-200", supplierVariantId: "CJ-200-WHT-L", title: "レディース ショルダーバッグ ホワイト Lサイズ", specs: { color: "ホワイト", size: "L" } },
]);
assert.equal(exact.status, "candidate_found");
assert.equal(exact.candidates[0].candidateId, "right");
assert.equal(exact.candidates[0].status, "unique_candidate");

// Partial title and image/spec evidence may rank candidates, but never auto-confirm identity.
const titleOnly = rankSupplierMatchCandidates(
  { title: "レディース ショルダーバッグ ブラック Mサイズ" },
  [
    { id: "a", title: "レディース ショルダーバッグ ブラック" },
    { id: "b", title: "レディース ショルダーバッグ ブラウン" },
  ],
);
assert.equal(titleOnly.status, "review_required");
assert.ok(titleOnly.candidates[0].score > 0);
assert.ok(titleOnly.candidates.every((item) => item.status === "review"));

// Image URL is supporting evidence only, not sufficient for a unique identity.
const imageOnly = rankSupplierMatchCandidates(
  { imageUrl: "https://cdn.example.test/item.jpg" },
  [{ id: "image", imageUrl: "https://cdn.example.test/item.jpg" }],
);
assert.equal(imageOnly.status, "review_required");

// Conflicting specs penalize a candidate and are visible in the rationale.
const conflict = rankSupplierMatchCandidates(
  { title: "bag", specs: { color: "black", size: "M" } },
  [{ id: "conflict", title: "bag", specs: { color: "white", size: "L" } }],
);
assert.ok(conflict.candidates[0].score <= 0, `conflicting specs must cancel title-only evidence; got ${conflict.candidates[0].score}`);
assert.ok(conflict.candidates[0].reasons.some((reason) => reason.startsWith("spec_conflicts:")));

// Reused supplier product/variant IDs are surfaced and force manual review.
const duplicate = rankSupplierMatchCandidates(
  { supplierVariantId: "V-1" },
  [
    { id: "dup-a", supplierProductId: "P-1", supplierVariantId: "V-1" },
    { id: "dup-b", supplierProductId: "P-1", supplierVariantId: "V-1" },
  ],
);
assert.equal(duplicate.status, "review_required");
assert.ok(duplicate.duplicateSupplierIds.includes("v-1"));
assert.ok(duplicate.candidates.every((item) => item.status === "review"));

// No candidates must be an explicit outcome, not a fabricated match.
assert.deepEqual(
  rankSupplierMatchCandidates(target, []),
  { status: "no_candidates", candidates: [], duplicateSupplierIds: [] },
);

// URLs normalize a trailing slash, while variant IDs remain exact.
const urlAndVariant = rankSupplierMatchCandidates(
  { imageUrl: "https://cdn.example.test/item.jpg/" },
  [{ id: "url", imageUrl: "https://cdn.example.test/item.jpg" }],
);
assert.equal(urlAndVariant.status, "review_required");
console.log("Supplier match candidate tests: 7 scenarios passed");
