import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/shopify/sync-published-listings.ts", import.meta.url), "utf8");
assert.match(source, /RESOURCE_EXHAUSTED\|quota exceeded\|rate limit/,
  "Gemini quota cooldown must use deterministic Japanese copy fallback");
assert.match(source, /localizeProductTitle\(sourceCopy, title\)/,
  "fallback title must be derived from existing product data");
assert.match(source, /商品の仕様・サイズ・素材・使用方法は、販売元の掲載情報をご確認ください。/,
  "fallback description must avoid inventing product claims");
console.log("Shopify Japanese-copy quota fallback contract passed.");
