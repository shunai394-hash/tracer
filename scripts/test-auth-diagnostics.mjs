import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = await readFile(new URL("../app/api/channels/base/diagnostics/route.ts", import.meta.url), "utf8");
const shopify = await readFile(new URL("../app/api/admin/shopify/auth-check/route.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/tracer-shopify-auth-check.yml", import.meta.url), "utf8");

assert.match(base, /requireAutomationAuth/);
assert.match(base, /TRACER BASE AUTH PROBE/);
assert.match(base, /message\.match\(\/HTTP\[_ \]\(\\\\d\{3\}\)\//);
assert.match(base, /error: stage/);
assert.doesNotMatch(base, /error:\s*error instanceof Error\s*\?\s*error\.message/);
assert.doesNotMatch(base, /unique_key/);
assert.match(shopify, /TRACER SHOPIFY AUTH PROBE/);
assert.match(workflow, /api\\/channels\\/base\\/diagnostics/);
console.log("Read-only channel auth diagnostics: 8 assertions passed");
