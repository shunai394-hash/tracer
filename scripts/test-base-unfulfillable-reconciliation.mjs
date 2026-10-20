import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/cron/unpublish-unlinked/route.ts", import.meta.url), "utf8");
const queryStart = route.indexOf('const { data: failedBaseRows, error: failedBaseReadError }');
assert.notEqual(queryStart, -1, "BASE unfulfillable reconciliation query must exist");
const queryEnd = route.indexOf("if (failedBaseReadError)", queryStart);
assert.notEqual(queryEnd, -1, "BASE unfulfillable reconciliation query must have an error branch");
const query = route.slice(queryStart, queryEnd);

assert.match(query, /\.from\("channel_listings"\)/, "query must target channel listing records");
assert.match(query, /\.eq\("channel", "base"\)/, "query must be scoped to BASE");
assert.match(query, /\.eq\("status", "error"\)/, "already-hidden verified rows must not be selected for retry");
assert.match(query, /\.like\("last_error", "supplier_offer_not_fulfillable%"\)/, "unresolved supplier-offer failures must remain eligible for retry");
assert.match(route, /\.update\(\{ status: "hidden", last_error: "supplier_offer_not_fulfillable_hidden_verified"/, "confirmed hidden rows must retain the verified hidden marker");
console.log("BASE unfulfillable reconciliation retry filter: 5 assertions passed");
