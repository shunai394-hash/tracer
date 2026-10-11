import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = [
  "../app/api/intelligence/brightdata-ingest/route.ts",
  "../app/api/intelligence/normalize/route.ts",
  "../app/api/intelligence/opportunities/route.ts",
];
for (const path of routes) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  assert.match(source, /import \{ requireCronAuth \} from "@\/lib\/security\/cron-auth"/, `${path}: auth helper must be imported`);
  const handlers = [...source.matchAll(/export async function (GET|POST)\(request: Request\) \{/g)];
  assert.ok(handlers.length > 0, `${path}: expected guarded request handlers`);
  for (const handler of handlers) {
    const after = source.slice(handler.index, handler.index + 220);
    assert.match(after, /const authError = requireCronAuth\(request\);\s*if \(authError\) return authError;/, `${path} ${handler[1]}: auth must run before work`);
  }
}
console.log("Internal order/intelligence API auth guards: passed");
