#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const smoke = await readFile(new URL("./ai-live-product-feed-smoke.mjs", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/admin/ai-live/products/route.ts", import.meta.url), "utf8");

const checks = [
  ["smoke test is opt-in", smoke.includes('if (!baseUrl || !secret)')],
  ["smoke test sends GET only", smoke.includes('method: "GET"') && !/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(smoke)],
  ["secret is not printed", !/console\.(log|error)\([^\n]*secret/i.test(smoke)],
  ["uses bounded 20-item request", smoke.includes("?limit=20") && smoke.includes("body.products.length <= 20")],
  ["validates response allowlist", smoke.includes("allowedKeys") && smoke.includes("Unexpected response key")],
  ["rejects sensitive response keys", smoke.includes("forbiddenKeys") && /supplier|credential|secret|order/.test(smoke)],
  ["validates positive price and stock", smoke.includes("item.sellingPrice > 0") && smoke.includes("item.inStock, true")],
  ["validates BASE product URL", smoke.includes('productUrl.origin, "https://tracer.base.ec"') && smoke.includes('productUrl.pathname.startsWith("/items/")')],
  ["API route requires automation auth", route.includes("requireAutomationAuth(request)")],
  ["API route is read-only", route.includes(".from(\"shop_listings\")") && !/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(route)],
  ["API response omits supplier/cost fields", !/supplier_id|source_cost|shipping_cost|margin|profit/i.test(route)],
  ["API route returns no-store", route.includes('"Cache-Control": "no-store"')],
];

for (const [label, passed] of checks) {
  assert.ok(passed, label);
  console.log(`PASS ${label}`);
}
console.log(`AI-live authenticated feed smoke-test contract: ${checks.length} assertions passed`);
