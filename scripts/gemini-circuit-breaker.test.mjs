import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createGeminiRunCircuitBreaker, isGeminiCircuitBreakerFailure } from "../lib/intelligence/gemini-circuit-breaker.ts";

test("GEMINI_TIMEOUT opens the breaker and prevents another call in this run", () => {
  const breaker = createGeminiRunCircuitBreaker();
  assert.equal(breaker.canCall(0, 10), true);
  assert.equal(breaker.recordFailure(Object.assign(new Error("Gemini request timed out"), { code: "GEMINI_TIMEOUT" })), true);
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.canCall(1, 10), false);
});

test("429 and 503 provider errors open the breaker", () => {
  for (const status of [429, 503]) {
    const breaker = createGeminiRunCircuitBreaker();
    assert.equal(breaker.recordFailure(Object.assign(new Error("provider unavailable"), { status })), true);
    assert.equal(breaker.canCall(1, 10), false);
  }
});

test("ordinary classification errors do not open the provider-wide breaker", () => {
  const breaker = createGeminiRunCircuitBreaker();
  assert.equal(isGeminiCircuitBreakerFailure(new Error("invalid response shape")), false);
  assert.equal(breaker.recordFailure(new Error("invalid response shape")), false);
  assert.equal(breaker.canCall(1, 10), true);
});

test("classification provider failure is deferred instead of counted as non-product", async () => {
  const source = await readFile(new URL("../lib/intelligence/match-demand-products.ts", import.meta.url), "utf8");
  assert.match(source, /A provider failure is not evidence that this query is non-product/);
  assert.match(source, /intentDeferred \+= 1;\s*continue;/);
  assert.match(source, /geminiCircuitBreaker\.recordFailure\(error\)/);
});
