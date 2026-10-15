import assert from "node:assert/strict";
import fs from "node:fs";
import { persistedListingShippingCost } from "../lib/market/listing-shipping-cost.ts";
import { selectRecoverableVariant, verifyVariantSelectionInvariants } from "../lib/sources/cj/variant-select.ts";

assert.equal(persistedListingShippingCost({ supplierShippingCost: 4.75, convertedInternationalShipping: 712.5 }), 712.5);
assert.equal(persistedListingShippingCost({ supplierShippingCost: 0, convertedInternationalShipping: 0 }), 0);
assert.equal(persistedListingShippingCost({ supplierShippingCost: null, convertedInternationalShipping: 712.5 }), null);
assert.equal(persistedListingShippingCost({ supplierShippingCost: 4.75, convertedInternationalShipping: null }), null);
assert.equal(persistedListingShippingCost({ supplierShippingCost: -1, convertedInternationalShipping: 712.5 }), null);

const publisher = fs.readFileSync(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8");
assert.match(publisher, /persistedListingShippingCost\(\{ supplierShippingCost: num\(item\.listing\.shipping_cost\), convertedInternationalShipping: item\.profit\.internationalShipping \}\)/);
assert.doesNotMatch(publisher, /shipping_cost: num\(item\.listing\.shipping_cost\)/);

const repair = fs.readFileSync(new URL("../lib/suppliers/repair-cj-variants.ts", import.meta.url), "utf8");
assert.match(repair, /selectRecoverableVariant\(variants, knownVariantBarcode\(row\.metadata\)\)/);
assert.doesNotMatch(repair, /sellPrice\) - Number/);

const invariants = verifyVariantSelectionInvariants();
assert.equal(invariants.ok, true, JSON.stringify(invariants.cases.filter((item) => item.actual !== item.expected)));

const cheap = { vid: "cheap", productId: "p", sku: null, nameEn: null, sellPrice: "1", barcode: "111", inventory: 5 };
const dear = { vid: "dear", productId: "p", sku: null, nameEn: null, sellPrice: "20", barcode: "222", inventory: 5 };
assert.equal(selectRecoverableVariant([cheap, dear], null), null);
assert.equal(selectRecoverableVariant([cheap, dear], "222")?.vid, "dear");
assert.equal(selectRecoverableVariant([cheap], null)?.vid, "cheap");

console.log("listing shipping currency and variant recovery passed");
