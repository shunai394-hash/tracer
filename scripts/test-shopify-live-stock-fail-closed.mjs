import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const store = await readFile(new URL("../lib/shop/store.ts", import.meta.url), "utf8");

assert.match(store, /shopify_live_stock_not_configured/, "missing Shopify credentials must fail closed");
assert.match(store, /shopify_live_stock_no_variant_ids/, "an empty live-stock request must not silently use stale database stock");
assert.match(store, /shopify_live_stock_incomplete_response/, "partial Shopify responses must be rejected");
assert.match(store, /shopify_live_stock_quantity_unknown/, "unknown inventory quantities must be rejected");
assert.match(store, /Math\.max\(0, Math\.floor\(quantity\)\)/, "negative inventory must mark only that variant sold out");
assert.match(store, /shopify-live-stock-unavailable[\s\S]{0,250}return \[\]/, "Shopify API failure must return no storefront listings");
assert.match(store, /return live !== undefined && live > 0/, "only positively stocked, live-verified variants may render");
assert.doesNotMatch(store, /return live === undefined \|\| live > 0/, "unknown live stock must never pass through to the storefront");

console.log("Shopify live-stock fail-closed guards: 8 passed");
