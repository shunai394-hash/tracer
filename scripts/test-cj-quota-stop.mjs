import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
assert.match(source, /function hasExhaustedCJApiPoints\(/);
assert.match(source, /const remaining = Number\(points\.remaining\)/);
assert.match(source, /total <= 0 \|\| usedToday >= total/);
assert.match(source, /if \(hasExhaustedCJApiPoints\(diagnostic\)\) \{[\s\S]*?throw new CJRequestError/);
assert.match(source, /if \(attempt === maxAttempts\) \{\s*return response/);
assert.match(source, /QPS rate limited; retrying/);
console.log("CJ exhausted-quota retry guard: 6 assertions passed");
