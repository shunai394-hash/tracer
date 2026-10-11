import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = [
  "../app/api/intelligence/demand-cj-research/route.ts",
  "../app/api/intelligence/demand-cj-persist/route.ts",
];
for (const path of routes) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  assert.match(source, /import \{ requireAutomationAuth \} from "@\/lib\/security\/cron-auth"/, `${path}: auth helper must be imported`);
  assert.match(source, /const authError = await requireAutomationAuth\(request\);\s*if \(authError\) return authError;/, `${path}: reject unauthenticated requests before side effects`);
}
console.log("Demand CJ endpoint authentication guards: 4 passed");
