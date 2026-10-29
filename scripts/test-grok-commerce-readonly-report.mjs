import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/admin/commerce/bot-report/route.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

assert.match(route, /requireAutomationAuth\(request\)/);
assert.match(route, /createSupabaseAdminClient\(\)/);
assert.match(route, /writesPerformed:\s*false/);
assert.match(route, /scope:\s*"aggregate_counts_only"/);
assert.match(route, /"Cache-Control":\s*"no-store"/);
for (const table of ["commerce_products", "commerce_variants", "supplier_offers", "channel_listings", "cron_runs"]) assert.ok(route.includes(table));
assert.doesNotMatch(route, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
assert.match(packageJson.scripts.prebuild, /test:grok-commerce-readonly-report/);
assert.equal(packageJson.scripts["test:grok-commerce-readonly-report"], "node scripts/test-grok-commerce-readonly-report.mjs");

console.log("Read-only commerce bot report contract tests passed.");
