import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/tracer-core/auth-contracts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const auth = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("auth is only accepted with HTTP 200, matching identity, and all required permissions", () => {
  const probe = {
    provider: "shopify",
    configComplete: true,
    tokenExchangeStatus: 200,
    tokenReturned: true,
    apiStatus: 200,
    expectedIdentity: "gid://shopify/Shop/123",
    returnedIdentity: "gid://shopify/Shop/123",
    requiredPermissions: ["read_products", "write_products"],
    grantedPermissions: ["read_products", "write_products"],
  };
  assert.equal(auth.evaluateProviderProbe(probe).authenticated, true);
  assert.deepEqual(auth.evaluateProviderProbe({ ...probe, apiStatus: 401 }).blockers, ["provider_api_not_confirmed"]);
  assert.equal(auth.evaluateProviderProbe({ ...probe, tokenReturned: false }).blockers.includes("token_exchange_not_confirmed"), true);
  assert.equal(auth.evaluateProviderProbe({ ...probe, returnedIdentity: "gid://shopify/Shop/999" }).blockers.includes("provider_identity_mismatch"), true);
  assert.deepEqual(auth.evaluateProviderProbe({ ...probe, grantedPermissions: ["read_products"] }).missingPermissions, ["write_products"]);
});

test("configuration presence alone never proves authentication", () => {
  const result = auth.evaluateProviderProbe({
    provider: "base",
    configComplete: true,
    tokenExchangeStatus: null,
    tokenReturned: false,
    apiStatus: null,
    expectedIdentity: "base-shop",
    returnedIdentity: null,
    requiredPermissions: ["read_items"],
    grantedPermissions: [],
  });
  assert.equal(result.authenticated, false);
  assert.equal(result.blockers.includes("token_exchange_not_confirmed"), true);
  assert.equal(result.blockers.includes("provider_api_not_confirmed"), true);
  assert.equal(result.blockers.includes("provider_identity_mismatch"), true);
});
