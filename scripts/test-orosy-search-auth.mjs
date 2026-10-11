import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const route = await readFile(new URL("../app/api/intelligence/orosy-search/route.ts", import.meta.url), "utf8");
assert.ok(route.includes('import { requireAutomationAuth } from "@/lib/security/cron-auth"'), "internal Orosy search must use the shared automation auth guard");
assert.ok(route.indexOf("await requireAutomationAuth(request)") < route.indexOf("request.nextUrl.searchParams.get"), "authenticate before processing or searching a wholesale query");
assert.ok(route.includes("if (authError) return authError"), "reject unauthorized requests before supplier API use");
assert.ok(route.includes("searchOrosyProducts(query)"), "keep the existing Orosy search behavior after authentication");
console.log("Orosy search auth policy: 4 assertions passed");
