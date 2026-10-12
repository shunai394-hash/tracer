import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { requireCronAuth } from "../lib/security/cron-auth.ts";

const route = await readFile(new URL("../app/api/intelligence/ping/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/intelligence/page.tsx", import.meta.url), "utf8");
const auth = await readFile(new URL("../lib/security/cron-auth.ts", import.meta.url), "utf8");

const authCheck = route.indexOf("requireCronAuth(request)");
const providerCall = route.indexOf("pingIntelligenceLayer()");
assert.ok(authCheck >= 0, "route must require cron authentication");
assert.ok(providerCall > authCheck, "authentication must happen before the Gemini call");
assert.match(route, /if \(authError\) return authError;/);
assert.doesNotMatch(page, /pingIntelligenceLayer|\/api\/intelligence\/ping/);
assert.match(auth, /const cronSecret = process\.env\.CRON_SECRET;/);
assert.match(auth, /if \(!cronSecret\)[\s\S]*?status: 401/);
assert.match(auth, /request\.headers\.get\("authorization"\) !== `Bearer \$\{cronSecret\}`/);

// Exercise the real auth helper with an isolated test-only secret; no Gemini call is made.
const originalSecret = process.env.CRON_SECRET;
try {
  delete process.env.CRON_SECRET;
  const missingSecret = requireCronAuth(new Request("http://localhost/api/intelligence/ping", { method: "POST" }));
  assert.equal(missingSecret?.status, 401, "missing CRON_SECRET must fail closed");

  process.env.CRON_SECRET = "test-only-gemini-ping-secret";
  const noHeader = requireCronAuth(new Request("http://localhost/api/intelligence/ping", { method: "POST" }));
  assert.equal(noHeader?.status, 401, "missing Authorization header must be rejected");

  const wrongToken = requireCronAuth(new Request("http://localhost/api/intelligence/ping", {
    method: "POST",
    headers: { authorization: "Bearer wrong-test-token" },
  }));
  assert.equal(wrongToken?.status, 401, "wrong bearer token must be rejected");

  const correctToken = requireCronAuth(new Request("http://localhost/api/intelligence/ping", {
    method: "POST",
    headers: { authorization: "Bearer test-only-gemini-ping-secret" },
  }));
  assert.equal(correctToken, null, "correct test bearer token must pass the auth guard");
} finally {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
}

console.log("Gemini ping auth guard: source checks and 4 runtime cases passed");
