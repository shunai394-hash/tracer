import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const selector = await readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8");
assert.match(selector, /\.eq\("pipeline_reason", "supplier_inventory_reverification_required"\)/,
  "the selector must load listings held for fresh supplier verification");
assert.match(selector, /heldProductIds\.has\(productId\)/,
  "a held canonical product must be excluded before it can be republished");
assert.match(selector, /reasons: \["supplier_inventory_reverification_required"\]/,
  "the exclusion reason must be observable in the gate report");
assert.ok(selector.indexOf("heldProductIds.has(productId)") < selector.indexOf("eligible.push("),
  "the hold must be enforced before a product enters the eligible publication queue");
console.log("Supply sales-test stale-inventory hold: 4 assertions passed");
