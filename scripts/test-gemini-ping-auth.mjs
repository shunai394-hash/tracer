import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkCronAuth } from "../lib/security/cron-auth-core.ts";

const route = await readFile(new URL("../app/api/intelligence/ping/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/intelligence/page.tsx", import.meta.url), "utf8");
const auth = await readFile(new URL("../lib/security/cron-auth.ts", import.meta.url), "utf8");
const core = await readFile(new URL("../lib/security/cron-auth-core.ts", import.meta.url), "utf8");

const authCheck = route.indexOf("requireCronAuth(request)");
const providerCall = route.indexOf("pingIntelligenceLayer()");
assert.ok(authCheck >= 0, "route must require cron authentication");
assert.ok(providerCall > authCheck, "authentication must happen before the Gemini call");
assert.match(route, /if \(authError\) return authError;/);
assert.doesNotMatch(page, /pingIntelligenceLayer|\/api\/intelligence\/ping/);
assert.match(auth, /checkCronAuth\(request, process\.env\.CRON_SECRET\)/);
assert.match(core, /request\.headers\.get\("authorization"\) !== `Bearer \$\{cronSecret\}`/);

// Exercise the production decision function with isolated requests; no network or Gemini call is made.
const request = (authorization) => new Request("http://localhost/api/intelligence/ping", {
  method: "POST",
  ...(authorization ? { headers: { authorization } } : {}),
});
assert.equal(checkCronAuth(request(), undefined)?.status, 401, "missing CRON_SECRET must fail closed");
assert.equal(checkCronAuth(request(), "test-only-gemini-ping-secret")?.status, 401, "missing Authorization header must be rejected");
assert.equal(checkCronAuth(request("Bearer wrong-test-token"), "test-only-gemini-ping-secret")?.status, 401, "wrong bearer token must be rejected");
assert.equal(checkCronAuth(request("Bearer test-only-gemini-ping-secret"), "test-only-gemini-ping-secret"), null, "correct test bearer token must pass the auth guard");

console.log("Gemini ping auth guard: source checks and 4 runtime cases passed");
