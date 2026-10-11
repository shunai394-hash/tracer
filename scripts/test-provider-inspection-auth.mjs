import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = [
  "../app/api/intelligence/ai-product/route.ts",
  "../app/api/intelligence/brightdata-test/route.ts",
  "../app/api/intelligence/cj-search-inspect/route.ts",
  "../app/api/intelligence/cj-variant-inspect/route.ts",
];
for (const path of routes) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  assert.match(source, /import \{ requireAutomationAuth \} from "@\/lib\/security\/cron-auth"/, `${path}: auth helper must be imported`);
  assert.match(source, /const authError = await requireAutomationAuth\(request\);\s*if \(authError\) return authError;/, `${path}: auth must run before provider/AI calls`);
}
console.log("Provider and AI inspection API auth guards: passed");
