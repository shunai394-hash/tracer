import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const collector = await readFile(new URL("../lib/market/collect-bestsellers.ts", import.meta.url), "utf8");
const persistence = await readFile(new URL("../lib/market/persist-bestsellers.ts", import.meta.url), "utf8");
const marketSourcingCron = await readFile(new URL("../lib/ops/market-sourcing-cron.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/20261013120000_remove_amazon_rakuten_market_data.sql", import.meta.url), "utf8");

// Sourcing policy: do not fetch marketplace ranking sites; use direct suppliers instead.
assert.match(collector, /\["yahoo_shopping", "rakuten", "amazon\.co\.jp"\]\.includes\(selectedSource\.marketplace\)/);
assert.match(collector, /reason: "marketplace_source_removed_by_policy"/);
assert.match(collector, /const firstEnabledSourceIndex = MARKETPLACE_SOURCES\.findIndex/);
assert.match(collector, /if \(disabledMarketplace\) \{[\s\S]*?itemCount: 0,[\s\S]*?return/);

// Preserve existing persistence error accounting and bounded sourcing batches.
assert.match(persistence, /failedMarketplaces = collected\.marketplaces[\s\S]*?item\.reason !== "marketplace_source_removed_by_policy"/);
assert.match(marketSourcingCron, /const MARKET_SOURCING_BATCH_SIZE = 10;/);
assert.match(marketSourcingCron, /canonicalVariantEvidenceWriteFailures \+ observation\.failedMarketplaces\.length/);
assert.doesNotMatch(marketSourcingCron, /canonicalVariantEvidenceWriteFailures \+ observation\.skippedMarketplaces\.length/);

// Disabling discovery sources must not trigger unapproved deletion of historical evidence.
assert.match(migration, /Intentionally no-op migration/i);
assert.doesNotMatch(migration, /\bdelete\s+from\s+public\./i);
assert.match(migration, /Do not delete historical observations, identifiers, or evidence/i);

console.log("All marketplace ranking sources disabled; historical evidence preserved.");
