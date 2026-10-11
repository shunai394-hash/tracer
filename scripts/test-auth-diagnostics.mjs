import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = await readFile(new URL("../app/api/channels/base/diagnostics/route.ts", import.meta.url), "utf8");
const shopify = await readFile(new URL("../app/api/admin/shopify/auth-check/route.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../.github/workflows/tracer-shopify-auth-check.yml", import.meta.url), "utf8");

assert.match(base, /requireAutomationAuth/);
assert.match(base, /TRACER BASE AUTH PROBE/);
assert.ok(base.includes("message.match(/HTTP[_ ](\\d{3})/)"), "HTTP status parsing must use a digit capture group");
assert.match(base, /error: stage/);
assert.doesNotMatch(base, /error:\s*error instanceof Error\s*\?\s*error\.message/);
assert.doesNotMatch(base, /unique_key/);
assert.match(shopify, /probeShopifyAuth/);
assert.ok(workflow.includes("api/channels/base/diagnostics"), "read-only auth workflow must include BASE diagnostics");
console.log("Read-only channel auth diagnostics: 8 assertions passed");
