import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isHighConfidenceReconciliationCandidate } from "../lib/channels/base-reconciliation-confidence.ts";

const route = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
const policy = await readFile(new URL("../lib/channels/base-reconciliation-confidence.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/base-product-backup.yml", import.meta.url), "utf8");
const candidate = {
  score: 100, topScore: 100, topCandidateCount: 1,
  evidence: ["supplier_product_id_exact"],
  baseSupplierProductId: "P-1", baseSupplierVariantId: "V-RED",
  rowSupplierProductId: "P-1", rowSupplierVariantId: "V-RED",
  duplicateIdentityCount: 1,
};
assert.equal(isHighConfidenceReconciliationCandidate(candidate), true, "exact unique product+variant evidence may be high-confidence");
assert.equal(isHighConfidenceReconciliationCandidate({ ...candidate, baseSupplierVariantId: "V-BLUE", rowSupplierVariantId: "V-RED" }), false, "variant mismatch must require review");
assert.equal(isHighConfidenceReconciliationCandidate({ ...candidate, baseSupplierProductId: "P-2", rowSupplierProductId: "P-1" }), false, "contradictory product identity must require review");
assert.equal(isHighConfidenceReconciliationCandidate({ ...candidate, duplicateIdentityCount: 2 }), false, "duplicate supplier identity must require review");
assert.equal(isHighConfidenceReconciliationCandidate({ ...candidate, topCandidateCount: 2 }), false, "tied top candidates must require review");
assert.equal(isHighConfidenceReconciliationCandidate({ ...candidate, score: 30, topScore: 30, evidence: ["image_url_exact"] }), false, "image-only evidence must not be high-confidence");
assert.equal(isHighConfidenceReconciliationCandidate({ ...candidate, score: 70, topScore: 100 }), false, "non-top candidates must require review");

assert.match(route, /requireAutomationAuth/);
assert.match(route, /createSupabaseAdminClient/);
assert.match(route, /export async function POST/);
assert.match(route, /BASE_SNAPSHOT_INPUT_INCOMPLETE_OR_INVALID/);
assert.match(route, /BASE_SNAPSHOT_INPUT_ID_MISSING_OR_DUPLICATE/);
assert.match(route, /shop_listings/);
assert.match(route, /exactBaseIdMappedCount/);
assert.match(route, /baseItemsWithoutExactMappingCount/);
assert.match(route, /exactTitleCandidateCount/);
assert.match(route, /supplier_product_id_exact/);
assert.match(route, /supplier_variant_id_exact/);
assert.match(route, /image_url_exact/);
assert.doesNotMatch(route, /url\.search\s*=\s*""/); // image URL query parameters must not be discarded
assert.match(route, /specification_overlap/);
assert.match(route, /partialTitleScore/);
assert.match(route, /Script=Han.*Script=Hiragana.*Script=Katakana/); // Japanese unspaced titles use CJK bigrams
assert.match(route, /scoredCandidates/);
assert.match(route, /MULTIPLE_TOP_CANDIDATES_REVIEW_REQUIRED/);
assert.match(policy, /baseVariant && baseVariant !== rowVariant/); // variant mismatch requires review
assert.match(policy, /baseProduct && rowProduct && baseProduct !== rowProduct/);
assert.match(policy, /input\.score !== input\.topScore \|\| input\.topCandidateCount !== 1/);
assert.match(route, /candidateIdentityCounts\.get\(identityKey\) \?\? 0/);
assert.match(policy, /input\.duplicateIdentityCount > 1/);
assert.match(policy, /input\.evidence\.some\(\(entry\) => entry === "supplier_product_id_exact" \|\| entry === "supplier_variant_id_exact"\)/);
assert.match(route, /REVIEW_REQUIRED/);
assert.doesNotMatch(route, /score >= 100 \? "HIGH_CONFIDENCE_CANDIDATE_NOT_AUTO_MAPPED"/);
assert.match(route, /baseItemsWithScoredCandidateCount/);
assert.match(route, /never auto-mapped/);
assert.match(route, /Cache-Control.*no-store, private/);
assert.doesNotMatch(route, /\.update\(|\.insert\(|\.upsert\(|createBaseItem\(|editBaseItem\(/);
assert.match(workflow, /api\/admin\/channels\/base\/reconciliation/);
assert.match(workflow, /body: JSON\.stringify\(\{ snapshot \}\)/);
assert.match(workflow, /tracer-base-\*\.json/);
assert.match(workflow, /BASE_RECONCILIATION_INCOMPLETE_OR_COUNT_MISMATCH/);
console.log("BASE/TRACER reconciliation report contract: scored candidate safeguards asserted");
