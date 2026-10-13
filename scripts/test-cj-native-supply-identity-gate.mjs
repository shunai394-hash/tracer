import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8");
assert.match(source, /nativeCjSupplyIdentity[\\s\\S]*?verification_status === "verified"[\\s\\S]*?shipping_status === "verified"/, "native CJ identity must require verified product/variant and shipping evidence");
assert.match(source, /if \\(!nativeCjSupplyIdentity && \\(num\\(listing\\.identity_confidence\\) === null/, "generic identity confidence must not block a verified native CJ product/variant");
assert.match(source, /identityConfidence: nativeCjSupplyIdentity \\? 1 : num\\(listing\\.identity_confidence\\)/, "native CJ evidence must be passed to the sales-test gate");
assert.match(source, /candidate\\.price_confirmed === true[\\s\\S]*?candidate\\.inventory_confirmed === true[\\s\\S]*?candidate\\.orderable === true[\\s\\S]*?candidate\\.tracking_available === true[\\s\\S]*?candidate\\.api_available === true/, "native identity must not bypass price, stock, orderability, tracking or API gates");
assert.match(source, /profitCalculable: profit\\.calculable[\\s\\S]*?contributionProfit: profit\\.contributionProfit/, "positive contribution-profit gate remains in the flow");
console.log("CJ-native supply identity regression: 5 assertions passed");
