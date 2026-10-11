import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/security/cron-auth.ts", import.meta.url), "utf8");
assert.match(source, /GITHUB_OIDC_ALLOWED_WORKFLOW_REFS/);
assert.match(source, /allowedWorkflowRefs\.includes\(claims\.workflow_ref\)/);
assert.match(source, /if \(!claims\.workflow_ref \|\| allowedWorkflowRefs\.length === 0\) return false/);
assert.match(source, /GITHUB_OIDC_ALLOWED_JOB_WORKFLOW_REFS/);
assert.doesNotMatch(source, /workflow_ref\.startsWith\(/);
console.log("Exact GitHub OIDC workflow allowlist contract: passed");
