import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/admin/channels/base/japanese-copy-repair/route.ts", import.meta.url), "utf8");

assert.match(route, /localizeProductTitle/,
  "BASE copy preview must have a deterministic title fallback when Gemini quota is exhausted");
assert.match(route, /localizeProductDescription/,
  "BASE copy preview must have a deterministic description fallback");
assert.match(route, /deterministicJapaneseCopy\(title, detail\)/,
  "the fallback must use only the current product's source title and detail");
assert.match(route, /RESOURCE_EXHAUSTED/,
  "Gemini quota exhaustion must be recognized");
assert.match(route, /if \(fallback\) return fallback;/,
  "only a validated Japanese fallback may replace the quota error");
assert.match(route, /if \(!isJapaneseProductDescription\(fallbackDetail\)\) return null;/,
  "fallback descriptions must pass Japanese-language validation");
assert.match(route, /if \(!apply\)/,
  "the endpoint must preserve its read-only preview mode");

console.log("BASE Japanese copy quota fallback checks passed");
