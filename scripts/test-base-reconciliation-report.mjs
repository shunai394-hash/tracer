import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/admin/channels/base/reconciliation/route.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/base-product-backup.yml", import.meta.url), "utf8");

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
assert.doesNotMatch(route, /url\.search\s*=\s*["']["']/); // image URL query parameters must not be discarded
assert.match(route, /specification_overlap/);
assert.match(route, /partialTitleScore/);
assert.match(route, /Script=Han.*Script=Hiragana.*Script=Katakana/); // Japanese unspaced titles use CJK bigrams
assert.match(route, /scoredCandidates/);
assert.match(route, /MULTIPLE_TOP_CANDIDATES_REVIEW_REQUIRED/);
assert.match(route, /REVIEW_REQUIRED/);
assert.match(route, /baseItemsWithScoredCandidateCount/);
assert.match(route, /never auto-mapped/);
assert.match(route, /Cache-Control.*no-store, private/);
assert.doesNotMatch(route, /\.update\(|\.insert\(|\.upsert\(|createBaseItem\(|editBaseItem\(/);
assert.match(workflow, /api\/admin\/channels\/base\/reconciliation/);
assert.match(workflow, /body: JSON\.stringify\(\{ snapshot \}\)/);
assert.match(workflow, /tracer-base-\*\.json/);
assert.match(workflow, /BASE_RECONCILIATION_INCOMPLETE_OR_COUNT_MISMATCH/);
console.log("BASE/TRACER reconciliation report contract: scored candidate safeguards asserted");
