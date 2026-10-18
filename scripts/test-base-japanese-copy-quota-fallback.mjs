import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deterministicJapaneseCopy } from "../lib/channels/base/japanese-copy-fallback.ts";
import { isJapaneseProductTitle } from "../lib/intelligence/japanese-product.ts";

const route = await readFile(new URL("../app/api/admin/channels/base/japanese-copy-repair/route.ts", import.meta.url), "utf8");

assert.match(route, /deterministicJapaneseCopy\(title, detail\)/, "route must use deterministic fallback");
assert.match(route, /RESOURCE_EXHAUSTED/, "Gemini quota exhaustion must be recognized");
assert.match(route, /translated_variant_not_localized/, "unlocalized variants must be rejected");
assert.match(route, /if \(!apply\)/, "preview mode must remain read-only");

const knownSource = "Hand Painted Arowana Master Cup Ceramic Household Tea Cup";
const known = deterministicJapaneseCopy(knownSource, knownSource);
assert.ok(known, "known source-grounded title should produce fallback copy");
assert.equal(isJapaneseProductTitle(known.title), true);
assert.match(known.title, /アロワナ|セラミック|ティーカップ/);
assert.match(known.detail, /[ぁ-んァ-ヶ一-龯々〆ヵー]/);

for (const ambiguousTitle of ["Blue", "Linque", "Reddish Brown"]) {
  assert.equal(deterministicJapaneseCopy(ambiguousTitle, ""), null, `ambiguous title must not be fabricated: ${ambiguousTitle}`);
}

console.log("BASE Japanese copy quota fallback behavior checks passed");
