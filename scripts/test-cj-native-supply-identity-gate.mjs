import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8");
assert.ok(source.includes('candidate.verification_status === "verified"'), "native CJ identity requires verified supplier evidence");
assert.ok(source.includes('candidate.shipping_status === "verified"'), "native CJ identity requires verified shipping evidence");
assert.ok(source.includes('if (!nativeCjSupplyIdentity && (num(listing.identity_confidence) === null'), "generic identity confidence must not block verified native CJ product/variant identity");
assert.ok(source.includes('identityConfidence: nativeCjSupplyIdentity ? 1 : num(listing.identity_confidence)'), "native CJ evidence must be passed to the sales-test gate");
assert.ok(source.includes('candidate.price_confirmed === true') && source.includes('candidate.inventory_confirmed === true') && source.includes('candidate.orderable === true') && source.includes('candidate.tracking_available === true') && source.includes('candidate.api_available === true'), "native identity must not bypass price, stock, orderability, tracking or API gates");
assert.ok(source.includes('profitCalculable: profit.calculable') && source.includes('contributionProfit: profit.contributionProfit'), "contribution-profit gate must remain in the flow");
console.log("CJ-native supply identity regression: 6 assertions passed");
