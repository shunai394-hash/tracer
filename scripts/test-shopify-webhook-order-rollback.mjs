import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
assert.match(source, /cleanupOrderId\s*=\s*String\(inserted\.data\.id\)/, "persisted parent order must be tracked for rollback");
assert.match(source, /from\("shop_order_items"\)\.delete\(\)\.eq\("order_id",\s*cleanupOrderId\)/, "rollback must remove partially inserted order items");
assert.match(source, /from\("shop_orders"\)\.delete\(\)[\s\S]*?\.eq\("id",\s*cleanupOrderId\)[\s\S]*?\.eq\("shopify_order_id",\s*cleanupExternalId\)/, "rollback must remove only the matching parent order");
assert.match(source, /TRACER SHOPIFY ORDER WEBHOOK ROLLBACK ERROR/, "rollback failures must be visible without exposing credentials");
console.log("Shopify webhook partial-order rollback: 4 source-contract assertions passed");
