import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasConflictingSupplierVariantListing } from "../lib/market/supplier-variant-listing-guard.ts";

const row = (id) => ({ id });
assert.equal(hasConflictingSupplierVariantListing([], null), false, "no existing listings is safe");
assert.equal(hasConflictingSupplierVariantListing([row("current")], "current"), false, "updating the same listing is safe");
assert.equal(hasConflictingSupplierVariantListing([row("current"), row("other")], "current"), true, "another listing for the same supplier variant blocks publication");
assert.equal(hasConflictingSupplierVariantListing([row("other")], null), true, "new listing must not duplicate an existing supplier variant");
assert.equal(hasConflictingSupplierVariantListing([row("a"), row("b"), row("c")], "a"), true, "multiple conflicts must fail closed");

const market = readFileSync(new URL("../lib/market/select-sales-tests.ts", import.meta.url), "utf8");
const supply = readFileSync(new URL("../lib/market/select-supply-sales-tests.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20261011200000_shop_listings_unique_published_supplier_variant.sql", import.meta.url), "utf8");
assert.match(market, /hasConflictingSupplierVariantListing/);
assert.match(market, /supplier_variant_listing_conflict_lookup_failed/);
assert.match(market, /duplicate_supplier_variant_listing/);
assert.match(supply, /hasConflictingSupplierVariantListing/);
assert.match(supply, /supplier_variant_listing_conflict_lookup_failed/);
assert.match(supply, /duplicate_supplier_variant_listing/);
assert.match(migration, /create unique index if not exists shop_listings_published_supplier_variant_uidx/i);
assert.match(migration, /where published = true and supplier_variant_id is not null/i);
console.log("PASS: supplier-variant duplicate guard cases and both publication-path wiring checks");
