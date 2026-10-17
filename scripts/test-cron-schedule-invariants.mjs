import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const crons = config.crons ?? [];
const patrol = crons.find((entry) => entry.path === "/api/cron/patrol-ai");
assert.ok(patrol, "patrol-ai cron must remain configured");
assert.equal(patrol.schedule, "*/5 * * * *", "patrol-ai must run every five minutes");
for (const path of ["/api/cron/commerce-base-orders", "/api/cron/commerce-base-fulfillment", "/api/cron/commerce-cj-import", "/api/cron/commerce-procurement", "/api/cron/commerce-publish-base", "/api/cron/commerce-publish-shopify", "/api/cron/shopify-orders", "/api/cron/shopify-fulfillment"]) {
  assert.ok(crons.some((entry) => entry.path === path), `missing commerce cron: ${path}`);
}
const priceReconcile = crons.find((entry) => entry.path === "/api/cron/commerce-reprice-existing");
assert.ok(priceReconcile, "existing storefront price reconciliation must be scheduled");
assert.equal(priceReconcile.schedule, "3,8,13,18,23,28,33,38,43,48,53,58 * * * *", "price reconciliation must run every five minutes offset from publication and order polling");
console.log("TRACER cron schedule invariants: 12 assertions passed");
