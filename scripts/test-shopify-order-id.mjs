import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalShopifyOrderId, shopifyOrderIdForms, shopifyOrderNumericId } from "../lib/shopify/order-id.ts";

// The REST webhook (numeric id) and the GraphQL poller (GID) must agree on one
// stored order id, or the same Shopify order is imported and procured twice.
assert.equal(canonicalShopifyOrderId("1234"), "gid://shopify/Order/1234");
assert.equal(canonicalShopifyOrderId(1234), "gid://shopify/Order/1234");
assert.equal(canonicalShopifyOrderId("gid://shopify/Order/1234"), "gid://shopify/Order/1234");
assert.equal(canonicalShopifyOrderId(" gid://shopify/Order/1234 "), "gid://shopify/Order/1234");
assert.equal(shopifyOrderNumericId("gid://shopify/Order/1234"), shopifyOrderNumericId(1234));
assert.deepEqual(shopifyOrderIdForms(1234), ["gid://shopify/Order/1234", "1234"]);
for (const bad of [null, undefined, "", "0", "-1", "12a", "gid://shopify/Product/1234", 1.5, {}]) {
  assert.equal(canonicalShopifyOrderId(bad), null, `rejects ${JSON.stringify(bad)}`);
  assert.deepEqual(shopifyOrderIdForms(bad), []);
}

const webhook = await readFile(new URL("../app/api/webhooks/shopify/orders/route.ts", import.meta.url), "utf8");
const poller = await readFile(new URL("../lib/shopify/sync-orders.ts", import.meta.url), "utf8");
assert.match(webhook, /canonicalShopifyOrderId\(order\.admin_graphql_api_id\) \?\? canonicalShopifyOrderId\(order\.id\)/);
assert.match(webhook, /\.in\("shopify_order_id", shopifyOrderIdForms\(externalId\)\)/);
assert.doesNotMatch(webhook, /String\(order\.id \?\? ""\)/, "the webhook must not store the raw numeric REST id");
assert.match(poller, /pageOrders\.flatMap\(\(order\) => shopifyOrderIdForms\(order\.id\)\)/);
assert.match(poller, /\.in\("shopify_order_id", shopifyOrderIdForms\(order\.id\)\)/);
console.log("PASS shopify order id canonicalization");
