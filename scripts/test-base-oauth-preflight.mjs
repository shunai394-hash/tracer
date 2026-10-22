import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const publisher = await readFile(new URL("../lib/channels/base-publisher.ts", import.meta.url), "utf8");
assert.match(publisher, /getBasePublicShopUrl/);
assert.match(publisher, /BASE_OAUTH_PREFLIGHT/);
assert.match(
  publisher,
  /await getBasePublicShopUrl\(\);[\s\S]*?catch \(error\)[\s\S]*?attempted: 0,[\s\S]*?failed: 1/,
  "BASE OAuth outage must fail fast before any per-listing mutation or repeated publication requests",
);
console.log("BASE OAuth preflight fail-fast contract passed");
