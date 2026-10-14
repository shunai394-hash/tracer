import assert from "node:assert/strict";
import { catalogCountsNeedReview } from "../lib/ops/catalog-count-check.ts";
assert.equal(catalogCountsNeedReview({shopListings:0,supplierListings:1076},{shopListings:106,supplierListings:57195}),true);
assert.equal(catalogCountsNeedReview({shopListings:104,supplierListings:57000},{shopListings:106,supplierListings:57195}),false);
assert.equal(catalogCountsNeedReview({shopListings:0,supplierListings:900},null),false);
console.log("Catalog count safety checks passed");
