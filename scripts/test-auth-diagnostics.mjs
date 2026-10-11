import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = await readFile(new URL("../app/api/channels/base/diagnostics/route.ts", import.meta.url), "utf8");
const shopify = await readFile(new URL("../app/api/admin/shopify/auth-check/route.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/tracer-shopify-auth-check.yml", import.meta.url), "utf8");
const baseClient = await readFile(new URL("../lib/channels/base.ts", import.meta.url), "utf8");

assert.match(base, /requireAutomationAuth/);
assert.match(base, /TRACER BASE AUTH PROBE/);
assert.match(base, /message\.match\(\/HTTP_.*\\d\{3\}.*\)/);
assert.match(base, /error: stage/);
assert.doesNotMatch(base, /error:\s*error instanceof Error\s*\?\s*error\.message/);
assert.doesNotMatch(base, /unique_key/);
assert.match(base, /probeBaseReadOnly/);
assert.doesNotMatch(base, /item_id:|unique_key:|customer_email|shipping_address/);
assert.match(baseClient, /BASE_ITEMS_PROBE_FAILED/);
assert.match(baseClient, /\/items\?limit=/);
assert.match(baseClient, /visibleCount/);
assert.match(baseClient, /unknownVisibilityCount/);
assert.match(baseClient, /itemMaxPages/);
assert.match(shopify, /probeShopifyAuth/);
assert.ok(workflow.includes("api/channels/base/diagnostics"), "read-only auth workflow must include BASE diagnostics");
console.log("Read-only channel auth diagnostics: 15 assertions passed");
