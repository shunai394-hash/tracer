import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/sources/cj/client.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function getCJProductDetail(");
assert.notEqual(start, -1, "CJ product detail function must exist");
const end = source.indexOf("\n/**", start);
assert.notEqual(end, -1, "CJ product detail function boundary must exist");
const detail = source.slice(start, end);
assert.match(detail, /if \(!response\.ok\)/, "HTTP failures must throw instead of returning an empty product");
assert.match(detail, /if \(payload\.result === false\)/, "CJ result:false must be treated as an API failure");
assert.match(detail, /throw new CJRequestError\(payload\.message \|\| "CJ product query failed"\)/,
  "CJ error details must be surfaced as a typed failure");
assert.match(detail, /return product \? normalizeProduct\(product\) : null/, "only a successful, valid empty detail may return null");
console.log("CJ product detail fail-closed guards: 4 passed");
