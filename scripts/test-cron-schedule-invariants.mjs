import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const crons = config.crons ?? [];
assert.equal(crons.length, 12, "all configured cron jobs must remain present");
const schedules = new Map(crons.map((entry) => [entry.path, entry.schedule]));
const expected = new Map([
  ["/api/cron/commerce-base-fulfillment", "14,44 * * * *"],
  ["/api/cron/commerce-base-orders", "1,31 * * * *"],
  ["/api/cron/commerce-cj-import", "0,30 * * * *"],
  ["/api/cron/commerce-procurement", "13,43 * * * *"],
  ["/api/cron/commerce-reprice-existing", "4,34 * * * *"],
  ["/api/cron/commerce-publish-base", "5,35 * * * *"],
  ["/api/cron/commerce-publish-shopify", "6,36 * * * *"],
  ["/api/cron/patrol-ai", "10,40 * * * *"],
  ["/api/cron/shopify-fulfillment", "7,37 * * * *"],
  ["/api/cron/shopify-orders", "2,32 * * * *"],
  ["/api/cron/base-legacy-price-reconcile", "17,47 * * * *"],
  ["/api/cron/shopify-publish", "19,49 * * * *"],
]);
for (const [path, schedule] of expected) {
  assert.equal(schedules.get(path), schedule, `${path} must use its staggered thirty-minute cadence`);
}
for (const entry of crons) {
  const minuteValues = entry.schedule.split(" ")[0].split(",").map(Number);
  assert.equal(minuteValues.length, 2, `${entry.path} must run exactly twice per hour`);
  assert.ok(minuteValues.every((minute) => Number.isInteger(minute) && minute >= 0 && minute <= 59), `${entry.path} must use explicit minute values`);
  assert.equal((minuteValues[1] - minuteValues[0] + 60) % 60, 30, `${entry.path} executions must be thirty minutes apart`);
}
console.log("TRACER cron schedule invariants: all 12 cron jobs run twice hourly, thirty minutes apart");
