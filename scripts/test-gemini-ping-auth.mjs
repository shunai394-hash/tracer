import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

console.log("Gemini ping auth guard: 7 assertions passed");
