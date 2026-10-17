import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const helper = await readFile(new URL("../lib/channels/base-mapping-audit.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/channels/base/diagnostics/route.ts", import.meta.url), "utf8");

// Guard the intended migration rule: current commerce rows are authoritative,
// while duplicates within that table and legacy-only duplicates remain ambiguous.
assert.match(helper, /if \(commerce > 1\) return \{ kind: "ambiguous" \}/);
assert.match(helper, /if \(commerce === 1\) return \{ kind: "commerce" \}/);
assert.match(helper, /if \(legacy > 1\) return \{ kind: "ambiguous" \}/);
assert.match(route, /classifyBaseMappingCounts\(legacyMatches\.length, commerceMatches\.length\)/);
assert.match(route, /mapping\.kind === "commerce"/);
assert.doesNotMatch(route, /const totalMatches = legacyMatches\.length \+ commerceMatches\.length/);
console.log("BASE mapping migration overlap classification: 6 assertions passed");
