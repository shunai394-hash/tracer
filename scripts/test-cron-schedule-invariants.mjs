import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const crons = config.crons ?? [];
assert.equal(crons.length, 12, "all configured cron jobs must remain present");
const schedules = new Map(crons.map((entry) => [entry.path, entry.schedule]));
const expected = new Map([
  ["/api/cron/commerce-base-fulfillment", "14,29,44,59 * * * *"],
  ["/api/cron/commerce-base-orders", "1,16,31,46 * * * *"],
  ["/api/cron/commerce-cj-import", "0,30 * * * *"],
  ["/api/cron/commerce-procurement", "13,28,43,58 * * * *"],
  ["/api/cron/commerce-reprice-existing", "4,34 * * * *"],
  ["/api/cron/commerce-publish-base", "*/5 * * * *"],
  ["/api/cron/commerce-publish-shopify", "*/5 * * * *"],
  ["/api/cron/patrol-ai", "*/5 * * * *"],
  ["/api/cron/shopify-fulfillment", "7,22,37,52 * * * *"],
  ["/api/cron/shopify-orders", "*/5 * * * *"],
  ["/api/cron/base-legacy-price-reconcile", "17,47 * * * *"],
  ["/api/cron/shopify-publish", "19,49 * * * *"],
]);
for (const [path, schedule] of expected) {
  assert.equal(schedules.get(path), schedule, `${path} must use the approved cadence`);
}
for (const [path] of expected) {
  assert.ok(crons.some((entry) => entry.path === path), `missing commerce cron: ${path}`);
}
console.log("TRACER cron schedule invariants: all 12 schedules match approved cadence");
