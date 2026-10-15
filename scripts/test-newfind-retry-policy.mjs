import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isRetryableRejectedNewfindEvent } from "../lib/integration/newfind-retry-policy.ts";

assert.equal(isRetryableRejectedNewfindEvent("decorative_craft_object_not_promoted"), true);
assert.equal(isRetryableRejectedNewfindEvent("discovery product missing"), true);
assert.equal(isRetryableRejectedNewfindEvent("discovery product missing after accepted TRACER event"), true);
assert.equal(isRetryableRejectedNewfindEvent("tracer_sales_url_http_404"), false);
assert.equal(isRetryableRejectedNewfindEvent("supplier_inventory_unverified"), false);
assert.equal(isRetryableRejectedNewfindEvent(null), false);
const retryWorkflow = await readFile(new URL("../.github/workflows/tracer-newfind-retry.yml", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
assert.ok(retryWorkflow.includes('cron: "*/5 * * * *"'), "NEWFIND delivery retry must have a five-minute scheduled owner");
assert.ok(retryWorkflow.includes("group: tracer-newfind-retry"), "NEWFIND retries must serialize so duplicate workers do not compete for the same delivery lease");
assert.ok(retryWorkflow.includes("/api/cron/newfind-retry"), "scheduled workflow must call the production retry route");
assert.equal(vercel.crons.some((cron) => cron.path === "/api/cron/newfind-retry"), false, "NEWFIND must have exactly one scheduled retry owner");

console.log("NEWFIND rejected-event retry policy checks passed");
