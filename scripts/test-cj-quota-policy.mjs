import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getCJQuotaCooldownUntil, isCJQuotaExhausted } from "../lib/sources/cj/rate-limit-policy.ts";

assert.equal(isCJQuotaExhausted({
  code: 1600200,
  message: "Too Many Requests, QPS limit is 1 time/1second",
  pointsInfo: { total: 0, usedToday: 0, remaining: 0 },
}), true);
assert.equal(isCJQuotaExhausted({
  code: 1600200,
  message: "Too Many Requests, QPS limit is 1 time/1second",
  pointsInfo: { total: 100, usedToday: 99, remaining: 1 },
}), false);
assert.equal(isCJQuotaExhausted({ code: 16900500, message: "quota exhausted" }), true);
assert.equal(isCJQuotaExhausted({ code: 1600200, message: "QPS limit is 1 time/1second" }), false);
assert.equal(
  getCJQuotaCooldownUntil(Date.parse("2026-10-12T00:00:00.000Z")),
  "2026-10-13T00:00:00.000Z",
);
const identityPersistence = await readFile(new URL("../lib/intelligence/persist-cj-supply-intelligence.ts", import.meta.url), "utf8");
const circuitRethrows = identityPersistence.match(/catch \(error\) \{ if \(isCJQuotaCircuitBlockingError\(error\)\) throw error;/g) ?? [];
assert.equal(circuitRethrows.length, 2, "both variant-list and direct-VID lookup catches must propagate quota-circuit blocking errors");
assert.match(identityPersistence, /import \{ isCJQuotaCircuitBlockingError \} from "@\/lib\/sources\/cj\/client";/, "identity persistence must use the shared quota-circuit classifier");
const persistBody = identityPersistence.slice(identityPersistence.indexOf("export async function persistCjSupplyIntelligence"));
assert.ok(persistBody.indexOf("await resolveMarketplaceIdentity") < persistBody.indexOf('from("supplier_listings").update'), "quota-blocking identity resolution must complete before supplier evidence is written");
console.log("CJ quota policy and identity-circuit propagation: 8 assertions passed");
