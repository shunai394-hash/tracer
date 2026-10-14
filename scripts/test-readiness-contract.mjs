import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/api/ready/route.ts", import.meta.url), "utf8");

assert.match(source, /if \(!status\.supabasePublic\) missingRequired\.push\("supabase_public"\)/);
assert.match(source, /if \(!status\.supabaseServiceRole\) missingRequired\.push\("supabase_service_role"\)/);
assert.match(source, /status: ready \? 200 : 503/);
assert.match(source, /headers: \{ "Cache-Control": "no-store" \}/);
assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY\s*:/);
assert.doesNotMatch(source, /apiKey\s*:/);

console.log("readiness endpoint contract: PASS");
