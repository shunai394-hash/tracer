import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateShopifyAdminReadiness } from "../lib/shopify/auth-readiness.ts";

assert.deepEqual(
  evaluateShopifyAdminReadiness({ probeOk: true, adminApiOk: false, missingScopes: ["write_products"] }),
  { authenticated: false, ready: false, missingScopes: ["write_products"] },
  "a successful shop probe must not mask an Admin API 401",
);
assert.deepEqual(
  evaluateShopifyAdminReadiness({ probeOk: true, adminApiOk: true, missingScopes: [] }),
  { authenticated: true, ready: true, missingScopes: [] },
);
assert.deepEqual(
  evaluateShopifyAdminReadiness({ probeOk: true, adminApiOk: true, missingScopes: ["write_inventory"] }),
  { authenticated: true, ready: false, missingScopes: ["write_inventory"] },
  "missing required scopes must fail readiness",
);
assert.deepEqual(
  evaluateShopifyAdminReadiness({ probeOk: false, adminApiOk: true, missingScopes: [] }),
  { authenticated: false, ready: false, missingScopes: [] },
);
const route = readFileSync(new URL("../app/api/admin/shopify/auth-check/route.ts", import.meta.url), "utf8");
assert.match(route, /ok: readiness\.ready/);
assert.match(route, /authenticated: readiness\.authenticated/);
assert.doesNotMatch(route, /ok: shopifyProbe\.ok/);
console.log("PASS: Shopify readiness requires a successful Admin API scope query and all required scopes");
