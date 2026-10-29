import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isMinimumListingPriceEligible, MINIMUM_LISTING_PRICE_JPY } from "../lib/commerce/minimum-listing-price.ts";

assert.equal(MINIMUM_LISTING_PRICE_JPY, 2500);
assert.equal(isMinimumListingPriceEligible(2499), false);
assert.equal(isMinimumListingPriceEligible("2499"), false);
assert.equal(isMinimumListingPriceEligible(2500), true);
assert.equal(isMinimumListingPriceEligible("2500"), true);
assert.equal(isMinimumListingPriceEligible(2500.01), true);
assert.equal(isMinimumListingPriceEligible(0), false);
assert.equal(isMinimumListingPriceEligible(null), false);
assert.equal(isMinimumListingPriceEligible("unknown"), false);

const [publish, newfindCommerce, newfindLegacy, withdrawal] = await Promise.all([
  readFile(new URL("../lib/commerce/publish.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/integration/newfind-commerce.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/integration/newfind.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/integration/newfind-reconcile.ts", import.meta.url), "utf8"),
]);
assert.match(publish, /isMinimumListingPriceEligible\(currentCanonicalPrice\.selling_price\)/, "BASE/Shopify publication rejects canonical prices below the floor");
assert.match(publish, /minimum_listing_price_below_2500/, "existing BASE/Shopify listings below the floor are routed to the unpublish path");
assert.match(newfindCommerce, /isMinimumListingPriceEligible\(listing\.sellingPrice\)/, "canonical NEWFIND promotion rejects low-price listings");
assert.match(newfindLegacy, /minimum_listing_price_below_2500/, "legacy NEWFIND promotion path rejects low-price listings");
assert.match(withdrawal, /!isMinimumListingPriceEligible\(listing\.selling_price\)/, "legacy NEWFIND withdrawal identifies processed promotions below the floor");

console.log("Minimum listing price policy tests passed.");
