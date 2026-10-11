import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routes = [
  "../app/api/intelligence/brightdata-ingest/route.ts",
  "../app/api/intelligence/normalize/route.ts",
  "../app/api/intelligence/opportunities/route.ts",
];
for (const path of routes) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  assert.match(source, /import \{ requireAutomationAuth \} from "@\/lib\/security\/cron-auth"/, `${path}: auth helper must be imported`);
  const handlers = [...source.matchAll(/export async function (GET|POST)\(request: Request\) \{/g)];
  assert.ok(handlers.length > 0, `${path}: expected guarded request handlers`);
  for (const handler of handlers) {
    const after = source.slice(handler.index, handler.index + 220);
    assert.match(after, /const authError = await requireAutomationAuth\(request\);\s*if \(authError\) return authError;/, `${path} ${handler[1]}: auth must run before work`);
  }
}
const authSource = await readFile(
  new URL("../lib/security/cron-auth.ts", import.meta.url),
  "utf8",
);
assert.match(authSource, /ALLOWED_GITHUB_OIDC_WORKFLOW_REFS = new Set\\(/, "OIDC workflow allowlist must be explicit");
assert.match(authSource, /typeof claims\\.workflow_ref !== "string"/, "missing workflow_ref must be rejected");
assert.match(authSource, /!ALLOWED_GITHUB_OIDC_WORKFLOW_REFS\\.has\\(claims\\.workflow_ref\\)/, "unlisted workflow refs must be rejected");
assert.doesNotMatch(authSource, /claims\\.workflow_ref\\.startsWith\\(/, "repo-wide workflow prefix is too permissive");
for (const workflow of [
  "tracer-production-patrol-15m.yml",
  "tracer-supply-first.yml",
  "tracer-production-smoke.yml",
  "tracer-publish-cj-now.yml",
  "tracer-product-trace.yml",
  "tracer-unpublish-unlinked.yml",
  "tracer-shopify-auth-check.yml",
  "tracer-reach-500-now.yml",
]) {
  assert.ok(authSource.includes(`shunai394-hash/tracer/.github/workflows/${workflow}@refs/heads/main`), `missing explicit OIDC workflow allowlist entry: ${workflow}`);
}
console.log("Internal API guards and exact OIDC workflow allowlist: passed");
