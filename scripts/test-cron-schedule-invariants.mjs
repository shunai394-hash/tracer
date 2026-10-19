import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const crons = config.crons ?? [];
assert.equal(crons.length, 12, "all configured cron jobs must remain present");
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
  ["/api/cron/base-legacy-price-reconcile", "2,17,32,47 * * * *"],
  ["/api/cron/shopify-publish", "*/5 * * * *"],
]);
assert.equal(new Set(crons.map((entry) => entry.path)).size, crons.length, "cron paths must be unique");
assert.deepEqual(new Set(crons.map((entry) => entry.path)), new Set(expected.keys()), "expected cron paths must remain configured");
for (const entry of crons) {
  assert.equal(expected.get(entry.path), entry.schedule, `${entry.path} must use its approved cadence`);
}
assert.equal(expected.get("/api/cron/commerce-cj-import"), "0,30 * * * *", "CJ import must run every thirty minutes");
for (const path of [
  "/api/cron/commerce-publish-base",
  "/api/cron/commerce-publish-shopify",
  "/api/cron/shopify-publish",
]) {
  assert.equal(expected.get(path), "*/5 * * * *", `${path} must publish every five minutes`);
}
console.log("TRACER cron schedule invariants: storefront publishing every 5 minutes; CJ import every 30 minutes; other schedules preserved");
