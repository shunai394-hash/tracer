import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/tracer-one-shot-supply-recovery.yml", import.meta.url), "utf8");
const health = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

assert.match(workflow, /\$BASE\/api\/health/);
assert.match(workflow, /grep -q "\$GITHUB_SHA"/);
assert.doesNotMatch(workflow, /curl[^\n]*\$BASE\/api\/cron\/supply-first/, "deployment preflight must not invoke a supplier-discovery cron");
assert.match(health, /gitCommitSha: process\.env\.VERCEL_GIT_COMMIT_SHA/);
assert.deepEqual(vercel.crons.filter((job) => job.path === "/api/cron/market-sourcing"), [], "marketplace sourcing must not run on a production timer");
console.log("Recovery preflight is non-mutating, commit-aware, and marketplace sourcing is unscheduled.");
