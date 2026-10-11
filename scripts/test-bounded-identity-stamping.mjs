import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/stamp-cj-identities.ts", import.meta.url), "utf8");

assert.match(source, /const IDENTITY_BATCH_SIZE = 100/);
assert.match(source, /\.range\(offset, offset \+ batchSize - 1\)/);
assert.match(source, /Math\.floor\(Date\.now\(\) \/ \(15 \* 60_000\)\) % pages/);
assert.match(source, /const IDENTITY_UPDATE_CONCURRENCY = 10/);
assert.match(source, /Promise\.all\(batch\.map\(\(item\) =>[\s\S]*?\.update\(item\.payload\)\.eq\("id", item\.id\)/);
assert.match(source, /payload\.product_id = null/);
assert.match(source, /candidateIds\.length > 0/);
console.log("Bounded demand identity stamping: 7 assertions passed");
