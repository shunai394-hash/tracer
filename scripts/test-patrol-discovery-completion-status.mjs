import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/run-intelligence-pipeline.ts", import.meta.url), "utf8");

// Retryable discovery failures must remain visible in the overall completion
// status even if unrelated pipeline stages can continue.
assert.ok(
  source.includes("const retryableDiscoveryDeferred = steps.some"),
  "pipeline must track retryable discovery deferrals separately",
);
assert.ok(
  source.includes("Boolean(deferredStep) || retryableDiscoveryDeferred"),
  "retryable discovery deferral must make the pipeline incomplete",
);
assert.ok(
  source.includes('["bestsellers", "supply", "supply_first", "dropship"].includes(step.name)'),
  "bestseller, supplier, supply-first, and dropship deferrals must be covered",
);
console.log("PASS: retryable discovery deferrals cannot produce a complete pipeline status");
