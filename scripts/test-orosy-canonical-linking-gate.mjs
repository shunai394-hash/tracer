import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/cron/orosy-bulk-import/route.ts", import.meta.url), "utf8");
const profit = await readFile(new URL("../lib/intelligence/simulate-profit.ts", import.meta.url), "utf8");

assert.match(route, /womenProductPriority/);
assert.match(route, /shippableVariations\.length !== 1/, "ambiguous product-level shipping quotes must fail closed");
assert.match(route, /shippingQuote\.unresolved/);
assert.match(route, /shippingQuote\.amount === null/);
assert.match(route, /shippingQuote\.currency\?\.toUpperCase\(\) !== "JPY"/);
assert.match(route, /const canonical = await supabase\.from\("products"\).*\.eq\("jan", jan\)/s);
assert.match(route, /PROFIT_ASSUMPTIONS, simulateContributionProfit/);
assert.match(route, /DOMESTIC_SHIPPING_ESTIMATE_JPY = 500/);
assert.match(route, /1 - variableCostRate - TARGET_CONTRIBUTION_MARGIN/);
assert.match(route, /domesticShipping: DOMESTIC_SHIPPING_ESTIMATE_JPY/);
assert.match(route, /requireDomesticShipping: true/);
assert.match(route, /!profit\.calculable/);
assert.match(route, /contributionMargin < TARGET_CONTRIBUTION_MARGIN \* 100/);
assert.match(route, /domestic_shipping_estimate_jpy: DOMESTIC_SHIPPING_ESTIMATE_JPY/);
assert.match(route, /profit_assumptions: PROFIT_ASSUMPTIONS/);
assert.ok(route.indexOf("const profit = simulateContributionProfit") < route.indexOf("const productId = await upsertProduct"), "profit gate must run before canonical/supplier/listing writes");
assert.doesNotMatch(route, /syncPublishedListingsToShopify/, "supplier discovery must not trigger broad channel sync");
assert.match(profit, /platform_fee_rate/);
assert.match(profit, /payment_fee_rate/);
assert.match(profit, /advertising_allowance_rate/);
assert.match(profit, /return_refund_reserve_rate/);
assert.match(profit, /fx_reserve_rate/);

console.log("Orosy canonical identity, shipping ambiguity, fully costed margin and no-side-effect invariants: 18 assertions passed");
