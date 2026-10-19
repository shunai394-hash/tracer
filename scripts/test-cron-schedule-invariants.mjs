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
  assert.notEqual(minutes, "*/5", `${entry.path} must not run every five minutes`);
  assert.notEqual(minutes, "*/15", `${entry.path} must not run every fifteen minutes`);
  assert.match(minutes, /^\\d+(,\\d+)?$/, `${entry.path} must use two staggered half-hourly executions`);
}
console.log("TRACER cron schedule invariants: all cron jobs are staggered to twice hourly");
