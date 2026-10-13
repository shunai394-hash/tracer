import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildThreeSiteCorrespondence, shopifyIdTail } from "../lib/channels/three-site-correspondence.ts";

const listing = (overrides = {}) => ({
  id: "L1", title: "LEDデスクライト", selling_price: 3980, inventory: 10, published: true,
  base_item_id: "B1", shopify_product_id: "gid://shopify/Product/11", shopify_variant_id: "gid://shopify/ProductVariant/21",
  ...overrides,
});
const baseItem = (overrides = {}) => ({ item_id: "B1", identifier: "TRC-L1", title: "LEDデスクライト", price: 3980, stock: 5, visible: 1, ...overrides });
const shopifyProduct = (overrides = {}) => ({
  id: "gid://shopify/Product/11", title: "LEDデスクライト", status: "ACTIVE", publishedOnPublication: true,
  variants: [{ id: "gid://shopify/ProductVariant/21", sku: "TRC-v1", price: "3980.00", inventoryQuantity: 5 }],
  ...overrides,
});
const run = (listings, baseItems, shopifyProducts) => buildThreeSiteCorrespondence({ listings, baseItems, shopifyProducts });
const issuesFor = (...args) => run(...args).rows[0].issues;

// One master listing, one product per channel, everything agreeing: consistent.
{
  const report = run([listing()], [baseItem()], [shopifyProduct()]);
  assert.deepEqual(report.rows[0].issues, []);
  assert.equal(report.rows[0].consistent, true);
  assert.equal(report.summary.linkedToBoth, 1);
  assert.equal(report.summary.consistent, 1);
}

// Legacy numeric Shopify ids still join.
assert.equal(shopifyIdTail("11"), shopifyIdTail("gid://shopify/Product/11"));
assert.equal(run([listing({ shopify_product_id: "11", shopify_variant_id: "21" })], [baseItem()], [shopifyProduct()]).rows[0].consistent, true);
assert.ok(issuesFor([listing({ shopify_variant_id: null })], [baseItem()], [shopifyProduct()]).includes("shopify_variant_id_missing"));
assert.ok(issuesFor([listing({ shopify_variant_id: "gid://shopify/ProductVariant/999" })], [baseItem()], [shopifyProduct()]).includes("shopify_variant_not_found"));
// The exact target variant must be found even after the first five variants.
{
  const variants = Array.from({ length: 6 }, (_, index) => ({
    id: `gid://shopify/ProductVariant/${index + 20}`,
    sku: `TRC-v${index}`,
    price: "3980.00",
    inventoryQuantity: 5,
  }));
  const report = run([listing({ shopify_variant_id: "gid://shopify/ProductVariant/25" })], [baseItem()], [shopifyProduct({ variants })]);
  assert.equal(report.rows[0].shopify.stock, 5);
  assert.ok(!report.rows[0].issues.includes("shopify_variant_not_found"));
}


assert.ok(issuesFor([listing({ base_item_id: null })], [], [shopifyProduct()]).includes("base_id_missing"));
assert.ok(issuesFor([listing({ shopify_product_id: null })], [baseItem()], []).includes("shopify_id_missing"));
assert.ok(issuesFor([listing()], [], [shopifyProduct()]).includes("base_item_not_found"));
assert.ok(issuesFor([listing()], [baseItem()], []).includes("shopify_product_not_found"));
assert.ok(issuesFor([listing()], [baseItem({ title: "LED Desk Lamp" })], [shopifyProduct()]).includes("base_title_not_japanese"));
assert.ok(issuesFor([listing()], [baseItem()], [shopifyProduct({ title: "LED Desk Lamp" })]).includes("shopify_title_not_japanese"));
assert.ok(issuesFor([listing()], [baseItem({ title: "LEDライト 白" })], [shopifyProduct()]).includes("title_differs_between_channels"));
assert.ok(issuesFor([listing()], [baseItem({ price: 4200 })], [shopifyProduct()]).includes("base_price_mismatch"));
assert.ok(issuesFor([listing()], [baseItem({ price: 4200 })], [shopifyProduct()]).includes("price_differs_between_channels"));
assert.ok(issuesFor([listing()], [baseItem({ stock: 4 })], [shopifyProduct()]).includes("inventory_differs_between_channels"));
assert.ok(issuesFor([listing()], [baseItem()], [shopifyProduct({ variants: [{ id: "gid://shopify/ProductVariant/21", sku: "TRC-v1", price: "3980.00", inventoryQuantity: 4 }] })]).includes("inventory_differs_between_channels"));
assert.ok(!issuesFor([listing()], [baseItem({ stock: 5 })], [shopifyProduct()]).includes("inventory_differs_between_channels"));
assert.ok(issuesFor([listing()], [baseItem()], [shopifyProduct({ status: "DRAFT" })]).includes("shopify_not_live_but_tracer_published"));
assert.ok(issuesFor([listing()], [baseItem()], [shopifyProduct({ status: "DRAFT" })]).includes("visibility_differs_between_channels"));
// Sold on a channel while TRACER does not sell it, or without TRACER stock.
assert.ok(issuesFor([listing({ published: false })], [baseItem()], [shopifyProduct()]).includes("base_live_but_tracer_unpublished"));
assert.ok(issuesFor([listing({ inventory: 0 })], [baseItem()], [shopifyProduct()]).includes("shopify_live_without_tracer_stock"));
assert.ok(issuesFor([listing({ inventory: 2 })], [baseItem({ stock: 5 })], [shopifyProduct()]).includes("base_stock_exceeds_tracer"));
// BASE stock 0 counts as not live.
assert.ok(issuesFor([listing({ published: false, inventory: 0 })], [baseItem({ stock: 0 })], [shopifyProduct({ status: "DRAFT" })]).every((i) => !i.includes("live_but")));

// Two TRACER listings claiming the same channel product are flagged on both.
{
  const report = run([listing(), listing({ id: "L2" })], [baseItem()], [shopifyProduct()]);
  for (const row of report.rows) {
    assert.ok(row.issues.includes("base_id_shared_by_listings"));
    assert.ok(row.issues.includes("shopify_id_shared_by_listings"));
  }
}

// Channel products that no listing points to are reported, never title-matched.
{
  const report = run([listing({ base_item_id: null, shopify_product_id: null })], [baseItem()], [shopifyProduct()]);
  assert.equal(report.summary.unlinkedBaseItems, 1);
  assert.equal(report.summary.unlinkedShopifyProducts, 1);
  assert.equal(report.summary.unlinkedBaseItemsLive, 1);
  assert.equal(report.rows[0].base.found, false, "a same-title BASE item must not be treated as linked");
}

// Duplicate channel products carrying one TRACER key.
{
  const report = run([listing()], [baseItem(), baseItem({ item_id: "B2" })], [shopifyProduct(), shopifyProduct({ id: "gid://shopify/Product/12" })]);
  assert.equal(report.summary.duplicateBaseIdentifiers, 1);
  assert.equal(report.summary.duplicateShopifySkus, 1);
}
// The single-product route is dry-run by default and writes only one listing.
{
  const route = await readFile(new URL("../app/api/admin/channels/single-product-sync/route.ts", import.meta.url), "utf8");
  const applyIndex = route.indexOf("const apply = body.apply === true;");
  const earlyReturn = route.indexOf("if (!apply) {");
  assert.ok(applyIndex > 0 && earlyReturn > applyIndex, "apply must default to false");
  assert.ok(earlyReturn < route.indexOf("syncPublishedListingsToShopify(1, [listingId])"), "dry run must return before any channel write");
  assert.ok(earlyReturn < route.indexOf("publishPublishedListingsToBase(1, [listingId])"), "dry run must return before any channel write");
  assert.doesNotMatch(route, /createCJOrder|executeSupplierPurchaseOrder|createDropshipPurchaseOrders/, "the sync route must never order");
  const correspondence = await readFile(new URL("../app/api/admin/channels/correspondence/route.ts", import.meta.url), "utf8");
  assert.match(correspondence, /variants\(first: 30\).*pageInfo \{ hasNextPage \}/s, "correspondence must detect incomplete variant pages");
  assert.match(correspondence, /node\.variants\.pageInfo\.hasNextPage[\s\S]*SHOPIFY_TRACER_VARIANTS_INCOMPLETE/, "incomplete variant reads must fail closed");
  assert.match(route, /variants\(first: 30\).*pageInfo \{ hasNextPage \}/s, "single-product preflight must detect incomplete variant pages");
  assert.match(route, /data\.product\?\.variants\.pageInfo\.hasNextPage[\s\S]*SHOPIFY_VARIANTS_INCOMPLETE/, "single-product preflight must fail closed on incomplete variants");
  assert.doesNotMatch(correspondence, /\.(insert|update|upsert|delete)\(|createBaseItem|editBaseItem|productUpdate|productCreate/, "the correspondence table must be read-only");
}
console.log("PASS three-site correspondence");
