import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const crons = config.crons ?? [];
const patrol = crons.find((entry) => entry.path === "/api/cron/patrol-ai");
assert.ok(patrol, "patrol-ai cron must remain configured");
assert.equal(patrol.schedule, "*/15 * * * *", "patrol-ai must run every fifteen minutes to reduce AI execution cost");

for (const path of ["/api/cron/commerce-base-orders", "/api/cron/commerce-base-fulfillment", "/api/cron/commerce-cj-import", "/api/cron/commerce-procurement", "/api/cron/commerce-publish-base", "/api/cron/commerce-publish-shopify", "/api/cron/shopify-publish", "/api/cron/shopify-orders", "/api/cron/shopify-fulfillment"]) {
  assert.ok(crons.some((entry) => entry.path === path), `missing commerce cron: ${path}`);
}

const cjImport = crons.find((entry) => entry.path === "/api/cron/commerce-cj-import");
assert.equal(cjImport.schedule, "0,30 * * * *", "CJ import must remain every 30 minutes");

for (const path of ["/api/cron/commerce-publish-base", "/api/cron/commerce-publish-shopify", "/api/cron/shopify-publish"]) {
  const publish = crons.find((entry) => entry.path === path);
  assert.equal(publish.schedule, "*/30 * * * *", `${path} must run every thirty minutes`);
}

const parityRepair = crons.find((entry) => entry.path === "/api/cron/commerce-channel-parity-repair");
assert.equal(parityRepair.schedule, "*/15 * * * *", "channel parity repair must run every fifteen minutes");
const shopifyOrders = crons.find((entry) => entry.path === "/api/cron/shopify-orders");
assert.equal(shopifyOrders.schedule, "*/10 * * * *", "Shopify paid orders must be polled every ten minutes");
const shopifyFulfillment = crons.find((entry) => entry.path === "/api/cron/shopify-fulfillment");
assert.equal(shopifyFulfillment.schedule, "7,37 * * * *", "Shopify tracking sync must remain every 30 minutes");
const priceReconcile = crons.find((entry) => entry.path === "/api/cron/commerce-reprice-existing");
assert.ok(priceReconcile, "existing storefront price reconciliation must be scheduled");
assert.equal(priceReconcile.schedule, "4,34 * * * *", "price reconciliation must run twice hourly, staggered after CJ import to reduce execution cost");
console.log("TRACER cron schedule invariants: cadence assertions passed");
