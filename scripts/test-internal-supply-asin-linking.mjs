import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMPTY_IDENTIFIERS, identifierQueryEntries, matchProductIdentity } from "../lib/market/identifiers.ts";
import { hasUniqueIdentitySelection } from "../lib/suppliers/cj-identity-reverify-policy.ts";

const marketAsin = "B0TESTASIN1";
const supplyAsin = "B0TESTASIN1";

assert.deepEqual(identifierQueryEntries({ ...EMPTY_IDENTIFIERS, asin: marketAsin }), [["asin", marketAsin]]);
assert.deepEqual(
  identifierQueryEntries({ ...EMPTY_IDENTIFIERS, asin: marketAsin, jan: "4573138107287", mpn: "MODEL-123" }),
  [["asin", marketAsin], ["jan", "4573138107287"], ["mpn", "MODEL-123"]],
);
const exact = matchProductIdentity({
  market: { ...EMPTY_IDENTIFIERS, asin: marketAsin, title: "Marketplace title" },
  supply: { ...EMPTY_IDENTIFIERS, asin: supplyAsin, title: "Supplier title" },
});
assert.equal(exact.salesEligible, true);
assert.equal(exact.method, "asin");
assert.equal(hasUniqueIdentitySelection(3, 1), true);
assert.equal(hasUniqueIdentitySelection(3, 2), false);

const ingestion = readFileSync(new URL("../app/api/internal/supply/route.ts", import.meta.url), "utf8");
assert.match(ingestion, /asin:\s*x\.asin\s*\?\?\s*null/);
assert.match(ingestion, /asin:\s*v\.asin\s*\?\?\s*null/);
const matcher = readFileSync(new URL("../lib/suppliers/internal-catalog.ts", import.meta.url), "utf8");
const sync = readFileSync(new URL("../lib/suppliers/sync-tracer-catalog.ts", import.meta.url), "utf8");
assert.match(matcher, /identifierQueryEntries\(marketIds\)/);
assert.match(sync, /identifierQueryEntries\(marketIds\)/);
assert.match(matcher, /variantIds\.asin === marketIds\.asin/);
assert.match(sync, /variantIds\.asin === marketIds\.asin/);

console.log("PASS: ASIN-only lookup, exact identity, ambiguous variant rejection, and persistence checks");
