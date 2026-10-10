import assert from "node:assert/strict";
import { finalizeInternalSupplyLinkRetry } from "../lib/suppliers/internal-link-retry-lifecycle.ts";

const events = [];

async function run(name, fn) {
  try {
    await fn();
    console.log("PASS", name);
  } catch (error) {
    console.error("FAIL", name, error);
    process.exitCode = 1;
  }
}

await run("success clears retry only after catalog sync", async () => {
  events.length = 0;
  const result = await finalizeInternalSupplyLinkRetry({
    syncCatalog: async () => { events.push("sync:start", "sync:success"); return { matched: true, reason: "ready" }; },
    persistFailure: async () => { events.push("persist:failure"); },
    clearRetry: async () => { events.push("clear:retry"); },
  });
  assert.equal(result.matched, true);
  assert.deepEqual(events, ["sync:start", "sync:success", "clear:retry"]);
});

await run("catalog sync rejection persists retry and never clears it", async () => {
  events.length = 0;
  await assert.rejects(() => finalizeInternalSupplyLinkRetry({
    syncCatalog: async () => { events.push("sync:rejected"); return { matched: false, reason: "variant_scope_incomplete_or_cross_product" }; },
    persistFailure: async (reason) => { events.push("persist:" + reason); },
    clearRetry: async () => { events.push("clear:retry"); },
  }), /retry retained: variant_scope_incomplete_or_cross_product/);
  assert.deepEqual(events, ["sync:rejected", "persist:variant_scope_incomplete_or_cross_product"]);
});

await run("catalog sync exception persists retry before returning failure", async () => {
  events.length = 0;
  await assert.rejects(() => finalizeInternalSupplyLinkRetry({
    syncCatalog: async () => { events.push("sync:throw"); throw new Error("atomic sync timeout"); },
    persistFailure: async (reason) => { events.push("persist:" + reason); },
    clearRetry: async () => { events.push("clear:retry"); },
  }), /retry retained: atomic sync timeout/);
  assert.deepEqual(events, ["sync:throw", "persist:atomic sync timeout"]);
});

await run("retry deletion failure is surfaced after sync success", async () => {
  events.length = 0;
  await assert.rejects(() => finalizeInternalSupplyLinkRetry({
    syncCatalog: async () => { events.push("sync:success"); return { matched: true }; },
    persistFailure: async () => { events.push("persist:failure"); },
    clearRetry: async () => { events.push("clear:failed"); throw new Error("delete failed"); },
  }), /delete failed/);
  assert.deepEqual(events, ["sync:success", "clear:failed"]);
});

console.log("Application retry lifecycle tests completed.");
