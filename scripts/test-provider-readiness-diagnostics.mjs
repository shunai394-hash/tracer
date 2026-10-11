import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../app/api/intelligence/pipeline-audit/route.ts", import.meta.url),
  "utf8",
);

for (const key of ["BRIGHTDATA_API_TOKEN", "GEMINI_API_KEY"]) {
  assert.ok(source.includes(key), `diagnostics must identify missing provider key ${key}`);
}
assert.match(source, /configured: Boolean\(process\.env\.BRIGHTDATA_API_TOKEN\)/);
assert.match(source, /configured: Boolean\(process\.env\.GEMINI_API_KEY\)/);
assert.match(source, /status: missingProviderKeys\.length \? "blocked" : "provider_keys_configured"/);
assert.match(source, /does not assert that collection, matching, publication, or ordering succeeded/);
assert.doesNotMatch(source, /process\.env\.(BRIGHTDATA_API_TOKEN|GEMINI_API_KEY)\s*[,}]/, "never return provider secret values");
console.log("Provider readiness diagnostics: missing keys and non-success semantics are explicit");
