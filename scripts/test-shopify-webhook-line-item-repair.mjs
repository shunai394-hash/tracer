import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");

// Duplicate webhook deliveries must enter the detail-repair path, not return before inspecting lines.
assert.match(source, /const existingOrderId = existing\.data \? String\(existing\.data\.id\) : null/);
assert.ok(!source.includes('if (existing.data) return NextResponse.json({ ok: true, duplicate: true'),
  "existing parent orders must not short-circuit before line-item reconciliation");
assert.match(source, /\.from\("shop_order_items"\)[\s\S]*?\.select\("shopify_line_item_id"\)[\s\S]*?\.eq\("order_id", existingOrderId\)/);
assert.match(source, /const existingLineIds = new Set/);
assert.match(source, /const missingItems = items\.filter/);
assert.match(source, /shopify_line_item_id_missing_manual_reconciliation_required/);
assert.match(source, /shopify_missing_line_item_invalid_manual_reconciliation_required/);
assert.match(source, /shopify_line_item_id: String\(item\.id\)/);
assert.match(source, /row\.error\.code === "23505"/);
assert.match(source, /repairedLineItems: missingItems\.length/);

// The repair path must resolve and validate SKU mappings before writing any missing detail.
assert.ok(source.indexOf("const resolution = resolveShopifyOrderSkus") < source.indexOf("if (existingOrderId)"),
  "SKU resolution must precede repair");
assert.ok(source.indexOf("Number.isInteger(quantity)") < source.indexOf('shopify_line_item_id: String(item.id)'),
  "repair must reject invalid quantities before insertion");
console.log("Shopify duplicate-webhook line-item repair contract: 12 assertions passed");
