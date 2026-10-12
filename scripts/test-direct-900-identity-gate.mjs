import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./direct-900-gate.ts", import.meta.url), "utf8");

// Supply discovery is not canonical identity. The bulk sales-test runner must
// never treat supply_discovered rows as eligible for product publication.
assert.match(source, /\.eq\(["']identity_status["'],\s*["']linked["']\)/);
assert.doesNotMatch(source, /identity_status\.eq\.supply_discovered/);
console.log("Direct 900 identity gate: canonical linked identity required");
