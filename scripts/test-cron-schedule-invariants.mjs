import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
const crons = config.crons ?? [];
const schedules = new Map(crons.map((entry) => [entry.path, entry.schedule]));
assert.equal(schedules.get("/api/cron/commerce-cj-import"), "0,30 * * * *");
assert.equal(schedules.get("/api/cron/commerce-publish-base"), "*/5 * * * *");
assert.equal(schedules.get("/api/cron/commerce-publish-shopify"), "*/5 * * * *");
assert.equal(schedules.get("/api/cron/shopify-orders"), "*/5 * * * *");
assert.equal(schedules.get("/api/cron/patrol-ai"), "*/5 * * * *");
assert.equal(schedules.get("/api/cron/commerce-base-fulfillment"), "14,29,44,59 * * * *");
assert.equal(schedules.get("/api/cron/shopify-fulfillment"), "7,22,37,52 * * * *");
assert.equal(schedules.get("/api/cron/commerce-base-orders"), "1,16,31,46 * * * *");
assert.equal(schedules.get("/api/cron/commerce-procurement"), "13,28,43,58 * * * *");
assert.equal(schedules.get("/api/cron/commerce-reprice-existing"), "4,34 * * * *");
for (const path of ["/api/cron/commerce-base-orders", "/api/cron/commerce-base-fulfillment", "/api/cron/commerce-cj-import", "/api/cron/commerce-procurement", "/api/cron/commerce-publish-base", "/api/cron/commerce-publish-shopify", "/api/cron/shopify-orders", "/api/cron/shopify-fulfillment"]) assert.ok(schedules.has(path), `missing commerce cron: ${path}`);
console.log("TRACER cron schedule invariants: storefront/order polling five-minute cadence and cost-heavy imports twice hourly verified");
