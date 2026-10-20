import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/cron/base-japanese-copy/route.ts", import.meta.url), "utf8");
assert.match(route, /\/\^\\d\+\$\//, "BASE item ID filter must use a numeric regex");
assert.doesNotMatch(route, /\/\^\\\\d\+\$\//, "BASE item ID filter must not double-escape \\d");
const numericId = /^\d+$/;
assert.equal(numericId.test("160408599"), true);
assert.equal(numericId.test(""), false);
assert.equal(numericId.test("abc"), false);
console.log("BASE Japanese copy repair numeric item ID filter checks passed");
