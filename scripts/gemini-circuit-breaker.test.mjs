import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../lib/intelligence/match-demand-products.ts", import.meta.url), "utf8");

test("Gemini quota and outage errors open the run-local circuit breaker", () => {
  assert.match(source, /status === 429 \|\| status === 503/);
  assert.match(source, /RESOURCE_EXHAUSTED\|UNAVAILABLE\|quota exceeded\|high demand/);
  assert.match(source, /geminiDisabledForRun = true/);
});

test("Gemini request timeouts also open the circuit breaker", () => {
  assert.match(source, /errorCode === "GEMINI_TIMEOUT"/);
  assert.match(source, /GEMINI_TIMEOUT\|Gemini request timed out/);
  assert.match(source, /if \(geminiDisabledForRun \|\| geminiCalls >= MAX_GEMINI_CLASSIFICATIONS_PER_RUN\)/);
});

test("Gemini provider failure is deferred, not counted as non-product", () => {
  assert.match(source, /A provider failure is not evidence that this query is non-product/);
  assert.match(source, /intentDeferred \+= 1;\s*continue;/);
});
