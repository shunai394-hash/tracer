import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/shopify/sync-orders.ts", import.meta.url), "utf8");
assert.match(source, /pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}/);
assert.match(source, /while \(hasNextPage\)/);
assert.match(source, /lineItems\(first: \$first, after: \$after\)/);
assert.match(source, /shopify_line_items_cursor_missing/);
assert.match(source, /shopify_line_items_page_missing/);
assert.match(source, /shopify_line_items_cursor_not_advancing/);
assert.match(source, /shopify_line_item_duplicate_id/);
assert.ok(source.indexOf("while (hasNextPage)") < source.indexOf("const supabase = createSupabaseAdminClient()"),
  "all line-item pages must resolve before local DB access");
assert.ok(source.indexOf("shopify_line_item_duplicate_id") < source.indexOf("const supabase = createSupabaseAdminClient()"),
  "duplicate line IDs must fail before local DB access");
console.log("Shopify order line-item pagination: 9 assertions passed");
