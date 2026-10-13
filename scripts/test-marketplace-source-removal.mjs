import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/20261013120000_remove_amazon_rakuten_market_data.sql", import.meta.url), "utf8");

assert.match(collector, /selectedSource\.marketplace === "amazon\.co\.jp"/);
assert.match(collector, /selectedSource\.marketplace === "rakuten"/);
assert.match(collector, /reason: "marketplace_source_removed_by_policy"/);
assert.match(collector, /if \(disabledMarketplace\) \{[\s\S]*?itemCount: 0,[\s\S]*?return/);
assert.match(migration, /delete from public\.marketplace_bestsellers[\s\S]*?lower\(trim\(marketplace\)\) in \('amazon\.co\.jp', 'amazon', 'rakuten'\)/i);
assert.match(migration, /delete from public\.evidence_ledger/i);
assert.match(migration, /delete from public\.product_identifiers/i);
assert.match(migration, /delete from public\.marketplace_bestseller_variants/i);
assert.match(migration, /customer orders, and channel records are intentionally[\\s\\S]*?preserved/i);

// After Amazon/Rakuten removal, the remaining approved Yahoo source must
// still persist only explicit structured child-variant evidence.
assert.match(
  collector,
  /const detail = parseYahooProductDetail\\(detailHtml\\);[\\s\\S]{0,500}item\\.canonicalVariants = parseCanonicalMarketplaceVariantEvidence\\(detailHtml, item\\.productUrl\\);[\\s\\S]{0,160}canonicalVariantCount \\+= item\\.canonicalVariants\\.length;/,
);

console.log("marketplace source removal and Yahoo canonical evidence tests passed");
