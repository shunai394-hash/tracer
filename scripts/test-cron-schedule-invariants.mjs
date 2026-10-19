import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const crons = config.crons ?? [];
const patrol = crons.find((entry) => entry.path === "/api/cron/patrol-ai");
assert.ok(patrol, "patrol-ai cron must remain configured");
assert.equal(patrol.schedule, "10,40 * * * *", "patrol-ai must run twice hourly to reduce scheduled invocations");
for (const path of ["/api/cron/commerce-base-orders", "/api/cron/commerce-base-fulfillment", "/api/cron/commerce-cj-import", "/api/cron/commerce-procurement", "/api/cron/commerce-publish-base", "/api/cron/commerce-publish-shopify", "/api/cron/shopify-orders", "/api/cron/shopify-fulfillment"]) {
  assert.ok(crons.some((entry) => entry.path === path), `missing commerce cron: ${path}`);
}
const priceReconcile = crons.find((entry) => entry.path === "/api/cron/commerce-reprice-existing");
assert.ok(priceReconcile, "existing storefront price reconciliation must be scheduled");
assert.equal(priceReconcile.schedule, "4,34 * * * *", "price reconciliation must run twice hourly, staggered after CJ import to reduce execution cost");
for (const entry of crons) {
  const minutes = entry.schedule.split(" ")[0];
  if (["/api/cron/commerce-publish-base", "/api/cron/commerce-publish-shopify", "/api/cron/shopify-orders"].includes(entry.path)) {
    assert.equal(entry.schedule, "*/5 * * * *", `${entry.path} must remain on the five-minute storefront/order cadence`);
    continue;
  }
  assert.notEqual(minutes, "*/5", `${entry.path} must not run every five minutes`);
  assert.notEqual(minutes, "*/15", `${entry.path} must not run every fifteen minutes`);
  const minuteValues = minutes.split(",").map(Number);
  if (entry.path === "/api/cron/shopify-fulfillment") {
    assert.equal(minutes, "7,22,37,52", "Shopify tracking sync must run every fifteen minutes");
    continue;
  }
  if (entry.path === "/api/cron/commerce-base-fulfillment") {
    assert.equal(minutes, "14,29,44,59", "BASE tracking sync must run every fifteen minutes");
    continue;
  }
  assert.equal(minuteValues.length, 2, `${entry.path} must run exactly twice per hour`);
  assert.equal((minuteValues[1] - minuteValues[0] + 60) % 60, 30, `${entry.path} executions must be thirty minutes apart`);
}
console.log("TRACER cron schedule invariants: cost-heavy cron jobs are staggered to twice hourly; Shopify tracking sync remains every fifteen minutes");
