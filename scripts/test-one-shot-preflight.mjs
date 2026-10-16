import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/tracer-one-shot-supply-recovery.yml", import.meta.url), "utf8");
const health = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");

assert.match(workflow, /\$BASE\/api\/health/);
assert.match(workflow, /grep -q "\$GITHUB_SHA"/);
assert.doesNotMatch(workflow, /curl[^\n]*\$BASE\/api\/cron\/supply-first/, "deployment preflight must not call a mutating cron endpoint");
assert.match(health, /gitCommitSha: process\.env\.VERCEL_GIT_COMMIT_SHA/);
console.log("One-shot preflight uses a non-mutating health check and waits for the expected deployment commit.");
