import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");
assert.match(source, /optionalDiscoverySteps = new Set\(\["bestsellers", "auxiliary_trends", "supply", "supply_first", "dropship"\]\)/,
  "retryable source discovery/cooldown stages must not block processing of persisted supply candidates");
assert.match(source, /optionalDiscoverySteps\.has\(step\.name\) && step\.retryable === true\) return false/,
  "only retryable skips in optional discovery stages are non-blocking");
assert.match(source, /const incomplete = pipelineTimedOut \|\| Boolean\(deferredStep\)/,
  "real core timeouts and deferred required stages must still fail completion");
for (const required of ["match", "supply_sales_test_select", "sales_test_select", "ordering", "test_ready"]) {
  assert.doesNotMatch(source, new RegExp('optionalDiscoverySteps = new Set\\(\\[[^\\]]*"' + required + '"'),
    required + " must remain a core pipeline stage");
}
assert.match(source, /supply_discovery_deferred_without_candidates/,
  "an empty supplier scan that defers must be explicitly retryable, not reported as a completed stage");
assert.match(source, /supplyFirstResult\?\.deadlineReached === true/,
  "deferred classification must inspect the scanner's explicit deadlineReached result");
assert.match(source, /Number\(supplyFirstResult\.candidateCount \?\? 0\) === 0/,
  "only empty deadline runs are deferred; partial candidate results remain available to downstream gates");
assert.ok(source.indexOf('runStep("supply_first"') < source.indexOf('runStep("bestsellers"'),
  "bounded supplier discovery must run before marketplace and demand enrichment can consume the patrol deadline");
assert.match(source, /discoverAndCreateCjSupply\(3,[\s\S]*?Date\.now\(\) \+ 18_000[\s\S]*?budgetMs: 20_000/,
  "supplier discovery must have an explicit bounded budget before slower pipeline stages");
assert.match(source, /verifiedSupplyPages = Math\.max\(1, Math\.ceil\(\(verifiedSupplyCount \?\? 0\) \/ verifiedSupplyPageSize\)\)/,
  "verified supplier candidates must be paginated across the full fresh supplier catalog");
assert.match(source, /Math\.floor\(Date\.now\(\) \/ 300_000\) % verifiedSupplyPages/,
  "the supplier candidate page must rotate on each five-minute patrol");
assert.match(source, /\.range\(verifiedSupplyOffset, verifiedSupplyOffset \+ verifiedSupplyPageSize - 1\)/,
  "rotating supplier candidate pages must be bounded");

console.log("Supply-first core completion: optional discovery cooldowns do not block the core cycle; empty deadline runs are deferred");
