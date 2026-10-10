import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMPTY_IDENTIFIERS, matchProductIdentity, identifierQueryEntries } from "../lib/market/identifiers.ts";

const market = { ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN1", title: "Marketplace title" };
const supply = { ...EMPTY_IDENTIFIERS, asin: "B0TESTASIN1", title: "Supplier title" };
const asinOnly = matchProductIdentity({ market, supply });
assert.equal(asinOnly.linked, true, "ASIN can surface a candidate");
assert.equal(asinOnly.salesEligible, false, "ASIN alone must never establish sellable identity");
assert.equal(asinOnly.method, "asin");

const barcodeMatch = matchProductIdentity({
  market: { ...market, jan: "4006381333931" },
  supply: { ...supply, jan: "4006381333931" },
});
assert.equal(barcodeMatch.salesEligible, true);
assert.equal(barcodeMatch.method, "jan");

const brandedMpn = matchProductIdentity({
  market: { ...market, mpn: "MODEL-123", brand: "Brand A" },
  supply: { ...supply, mpn: "MODEL-123", brand: " brand a " },
});
assert.equal(brandedMpn.salesEligible, true);
assert.equal(brandedMpn.method, "brand_mpn");

assert.deepEqual(identifierQueryEntries(market), [["asin", "B0TESTASIN1"]]);
const source = readFileSync(new URL("../lib/suppliers/internal-catalog.ts", import.meta.url), "utf8");
assert.match(source, /identifierQueryEntries\(marketIds\)/);
assert.match(source, /if \(!identity\.salesEligible\) continue/);
const migration = readFileSync(new URL("../supabase/migrations/20261011070000_internal_supply_asin_candidate_lookup.sql", import.meta.url), "utf8");
assert.match(migration, /internal_supply_products\s+add column if not exists asin text/i);
assert.match(migration, /internal_supply_variants\s+add column if not exists asin text/i);
console.log("PASS: ASIN is candidate-only; independent barcode and same-brand MPN can establish identity");
