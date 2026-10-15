import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
assert.match(source, /optionalDiscoverySteps = new Set\(\["bestsellers", "auxiliary_trends", "supply", "dropship"\]\)/,
  "retryable source discovery/cooldown stages must not block processing of persisted supply candidates");
assert.match(source, /optionalDiscoverySteps\.has\(step\.name\) && step\.retryable === true\) return false/,
  "only retryable skips in optional discovery stages are non-blocking");
assert.match(source, /const incomplete = pipelineTimedOut \|\| Boolean\(deferredStep\)/,
  "real core timeouts and deferred required stages must still fail completion");
for (const required of ["match", "supply_first", "supply_sales_test_select", "sales_test_select", "ordering", "test_ready"]) {
  assert.doesNotMatch(source, new RegExp('optionalDiscoverySteps = new Set\\(\\[[^\\]]*"' + required + '"'),
    required + " must remain a core pipeline stage");
}
assert.match(source, /supply_discovery_deferred_without_candidates/,
  "an empty supplier scan that defers must be explicitly retryable, not reported as a completed stage");
assert.match(source, /supplyFirstResult\?\.deadlineReached === true/,
  "deferred classification must inspect the scanner's explicit deadlineReached result");
assert.match(source, /Number\(supplyFirstResult\.candidateCount \?\? 0\) === 0/,
  "only empty deadline runs are deferred; partial candidate results remain available to downstream gates");

console.log("Supply-first core completion: optional discovery cooldowns do not block the core cycle; empty deadline runs are deferred");
