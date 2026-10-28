import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/admin/ops-bots/live-channel-check/route.ts", import.meta.url), "utf8");
assert.match(route, /requireAutomationAuth\(request\)/);
assert.match(route, /url\.searchParams\.get\("live"\) !== "1"/);
assert.match(route, /getBaseItemDetail\(id\)/);
assert.match(route, /shopifyGraphQL/);
assert.match(route, /maxBaseItems: 5/);
assert.match(route, /maxShopifyProducts: 20/);
assert.match(route, /liveVerification: "not_implemented"/);
assert.match(route, /identityVerified: str\(item\.item_id\) === id/);\nassert.match(route, /readCanonicalExpected\(\)/);\nassert.match(route, /sameShopifyProductId\(row\.external_product_id, node\.id\)/);\nassert.match(route, /sameShopifyVariantId\(row\.external_variant_id, variant\.id\)/);\nassert.match(route, /paritySummary/);\nassert.match(route, /skuMatch/);\nassert.match(route, /priceMatch/);\nassert.match(route, /stockMatch/);
assert.match(route, /Cache-Control/);
assert.doesNotMatch(route, /\.insert\s*\(|\.upsert\s*\(|\.update\s*\(|\.delete\s*\(|editBaseItem|createBaseItem|publishProduct|createCJOrder/);
console.log("Read-only live channel check contract: 18 assertions passed");
