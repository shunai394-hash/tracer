import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Mirrors the archived-readback workflow. An empty completed page is success; a stuck offset is not. */
function nextStep(input) {
  if (input.http !== 200 && input.http !== 207) return "http_fail";
  const auditErrors = input.priorAuditErrors || (input.ok ? 0 : 1);
  if (input.complete === true) return auditErrors ? "provider_fail" : "success";
  if (input.nextOffset === input.offset) return "offset_stall";
  return "continue";
}

assert.equal(nextStep({ http: 200, ok: true, offset: 0, nextOffset: 0, complete: true, priorAuditErrors: 0 }), "success");
assert.equal(nextStep({ http: 500, ok: false, offset: 0, nextOffset: 0, complete: false, priorAuditErrors: 0 }), "http_fail");
assert.equal(nextStep({ http: 207, ok: false, offset: 0, nextOffset: 0, complete: true, priorAuditErrors: 0 }), "provider_fail");
assert.equal(nextStep({ http: 200, ok: true, offset: 0, nextOffset: 10, complete: false, priorAuditErrors: 0 }), "continue");
assert.equal(nextStep({ http: 200, ok: true, offset: 10, nextOffset: 10, complete: false, priorAuditErrors: 0 }), "offset_stall");
assert.equal(nextStep({ http: 200, ok: true, offset: 10, nextOffset: 20, complete: true, priorAuditErrors: 1 }), "provider_fail");

const workflow = readFileSync(new URL("../.github/workflows/archived-external-publication-readback.yml", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/cron/archived-external-publication-readback/route.ts", import.meta.url), "utf8");
const completeAt = workflow.indexOf('complete" == "true"');
const stallAt = workflow.indexOf("Offset did not advance");
const maxAt = workflow.indexOf("Reached max_batches");
assert.ok(completeAt > 0 && stallAt > completeAt && maxAt > stallAt, "an empty final page must be allowed to finish before the offset-stall check");
assert.match(workflow, /http_code" != "200" && "\$http_code" != "207"/);
assert.match(workflow, /audit_errors != 0/);
assert.match(workflow, /exit 1/);
assert.match(route, /archived_listing_read_failed/);
assert.match(route, /status: 500/);
assert.match(route, /count !== null && offset \+ results\.length >= count/);
assert.match(route, /PROVIDER_PERMISSION_DENIED/);
assert.match(route, /mutationPerformed: false/);
assert.match(route, /status: summary\.baseReadErrors > 0 \|\| summary\.shopifyReadErrors > 0 \? 207 : 200/);
assert.doesNotMatch(route, /editBaseItem|productUpdate|deleteAllowlisted/);
console.log("archived readback pagination: ok");
