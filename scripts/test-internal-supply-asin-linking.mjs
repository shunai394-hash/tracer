import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMPTY_IDENTIFIERS, identifierQueryEntries, hasExactMarketplaceVariantIdentifierMatch, matchProductIdentity } from "../lib/market/identifiers.ts";
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
// ASIN is a search entry point only: it surfaces the candidate but never
// confirms the same product/variant or permission to sell on its own.
assert.equal(exact.method, "asin");
assert.equal(exact.linked, true);
assert.equal(exact.salesEligible, false);
const confirmed = matchProductIdentity({
  market: { ...EMPTY_IDENTIFIERS, asin: marketAsin, jan: "4573138107287" },
  supply: { ...EMPTY_IDENTIFIERS, asin: supplyAsin, jan: "4573138107287" },
});
assert.equal(confirmed.salesEligible, true);
assert.equal(confirmed.method, "jan");
assert.equal(hasExactMarketplaceVariantIdentifierMatch(
  { ...EMPTY_IDENTIFIERS, asin: marketAsin },
  { ...EMPTY_IDENTIFIERS, asin: supplyAsin },
), false);
assert.equal(hasExactMarketplaceVariantIdentifierMatch(
  { ...EMPTY_IDENTIFIERS, jan: "4006381333931" },
  { ...EMPTY_IDENTIFIERS, gtin: "4006381333931" },
), true);
assert.equal(hasExactMarketplaceVariantIdentifierMatch(
  { ...EMPTY_IDENTIFIERS, asin: marketAsin },
  { ...EMPTY_IDENTIFIERS, asin: "B0OTHERASIN" },
), false);
assert.equal(hasUniqueIdentitySelection(3, 1), true);
assert.equal(hasUniqueIdentitySelection(3, 2), false);

const ingestion = readFileSync(new URL("../app/api/internal/supply/route.ts", import.meta.url), "utf8");
assert.match(ingestion, /asin:\s*x\.asin\s*\?\?\s*null/);
assert.match(ingestion, /asin:\s*v\.asin\s*\?\?\s*null/);
const matcher = readFileSync(new URL("../lib/suppliers/internal-catalog.ts", import.meta.url), "utf8");
const sync = readFileSync(new URL("../lib/suppliers/sync-tracer-catalog.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261010200000_internal_supply_asin_identity.sql", import.meta.url), "utf8");
assert.match(migration, /internal_supply_products\s+add column if not exists asin text/i);
assert.match(migration, /internal_supply_variants\s+add column if not exists asin text/i);
assert.match(matcher, /identifierQueryEntries\(marketIds\)/);
assert.match(sync, /identifierQueryEntries\(marketIds\)/);
assert.match(matcher, /hasExactMarketplaceVariantIdentifierMatch/);
assert.match(sync, /hasExactMarketplaceVariantIdentifierMatch/);

console.log("PASS: ASIN-only lookup as search entry, ASIN never sales-eligible alone, exact barcode identity, ambiguous variant rejection, and persistence checks");
